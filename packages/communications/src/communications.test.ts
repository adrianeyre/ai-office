import { connections } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import {
  createRedactor,
  defaultCommunicationsAgentAvatar,
  type NewNotice,
  type OutboundMessage,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCommunications,
  CommunicationsError,
  type Communications,
} from "./communications.ts";
import type { NoticeView } from "./messages.ts";
import {
  databaseCommunicationsStore,
  memoryCommunicationsStore,
  type CommunicationsStore,
} from "./store.ts";
import { serveFakeWebhook, type FakeWebhook } from "./testing.ts";
import { defaultTransports } from "./transports/defaults.ts";
import { verifySignature, webhookTransport } from "./transports/webhook.ts";

// The Communications Agent and its Connections (PRD FR-90 to FR-94), with
// generic webhooks against fake webhook servers: each event a Connection's
// rules let through is delivered to it once, signed; failures are retried
// with exponential backoff, across a restart, for up to 24 hours; 5 in a
// row make a Connection failing, with an action Notice it is never sent;
// and its recovery is recorded. Every case runs twice: with everything in
// memory, and in Postgres 18.

const start = new Date("2026-10-10T09:00:00.000Z");
const publicUrl = "https://office.example.com";
const signingSecret = "whsec-0123456789abcdef-signing";
const encryptor = encryptorFromKey(Buffer.alloc(32, 9));

const sha = "a".repeat(40);
const merged = (pullRequest: number, issue = pullRequest - 10) =>
  ({
    type: "pull_request.merged",
    version: 1,
    floorId: "web-shop",
    issue,
    pullRequest,
    url: `https://github.com/adrianeyre/web-shop/pull/${String(pullRequest)}`,
    sha,
    by: "app",
  }) satisfies OfficeEvent;

interface Setup {
  readonly store: CommunicationsStore;
  readonly bus: EventBus;
  /** Moves the clock on. */
  readonly advance: (ms: number) => void;
  /** A Communications Agent over the store, as one server start makes it. */
  readonly communications: () => Communications;
  /** Raises a Notice as the orchestrator's would: stored, then published. */
  readonly raiseNotice: (notice: NewNotice) => Promise<{ id: string }>;
  /** Every Notice raised. */
  readonly notices: Map<string, NoticeView>;
  /** Every event so far. */
  readonly events: () => Promise<OfficeEvent[]>;
  /** A fake webhook server, closed after the test. */
  readonly webhook: () => Promise<FakeWebhook>;
  /** The sealed credentials as stored, for a Postgres-backed case. */
  readonly storedCredentials: (id: string) => Promise<string | undefined>;
}

type Case = readonly [string, (setup: Setup) => Promise<void>];

const servers: FakeWebhook[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setUp(
  store: CommunicationsStore,
  bus: EventBus,
  clock: { time: Date },
  storedCredentials: Setup["storedCredentials"],
): Setup {
  const notices = new Map<string, NoticeView>();
  let ids = 0;
  const raiseNotice = async (notice: NewNotice) => {
    ids += 1;
    const id = `notice-${String(ids)}`;
    notices.set(id, {
      id,
      kind: notice.kind,
      title: notice.title,
      floorId: notice.floorId ?? null,
      issue: notice.issue ?? null,
      pullRequest: notice.pullRequest ?? null,
      ciRunUrl: notice.ciRunUrl ?? null,
      links: notice.links ?? [],
    });
    await bus.publish({
      type: "notice.raised",
      version: 1,
      noticeId: id,
      kind: notice.kind,
      title: notice.title,
      ...(notice.floorId === undefined ? {} : { floorId: notice.floorId }),
    });
    return { id };
  };
  return {
    store,
    bus,
    notices,
    raiseNotice,
    storedCredentials,
    advance(ms) {
      clock.time = new Date(clock.time.getTime() + ms);
    },
    communications: () =>
      createCommunications({
        store,
        events: bus,
        encryptor,
        transports: {
          ...defaultTransports(),
          webhook: webhookTransport({ timeoutMs: 2000 }),
        },
        publicUrl,
        floorName: (floorId) =>
          Promise.resolve(
            (
              { "web-shop": "Web shop", blog: "Blog" } as Record<string, string>
            )[floorId],
          ),
        notice: (id) => Promise.resolve(notices.get(id)),
        raiseNotice,
        defaultModels: () => Promise.resolve({ Claude: "claude-opus-5-5" }),
        agentName: () => "Grace",
        redactor: createRedactor(),
        now: () => clock.time,
      }),
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
    async webhook() {
      const server = await serveFakeWebhook();
      servers.push(server);
      return server;
    },
  };
}

const webhookRequest = (
  name: string,
  url: string,
  extra: { secret?: string; rules?: Record<string, unknown> } = {},
) =>
  ({
    type: "webhook",
    name,
    ...(extra.rules === undefined ? {} : { rules: extra.rules }),
    credentials: {
      url,
      ...(extra.secret === undefined ? {} : { secret: extra.secret }),
    },
  }) as Parameters<Communications["add"]>[0];

const bodies = (server: FakeWebhook) =>
  server.received.map(({ body }) => body as Record<string, unknown>);

const cases: Case[] = [
  [
    "makes the Communications Agent at first start, once, with no Floor",
    async ({ communications, events }) => {
      const first = communications();
      const agent = await first.agent();
      expect(agent).toMatchObject({
        name: "Grace",
        role: "communications",
        aiProvider: "Claude",
        model: "claude-opus-5-5",
        modelOverride: null,
        enabled: true,
      });
      // Another start finds it.
      expect((await communications().agent()).createdAt).toEqual(
        agent.createdAt,
      );
      const renamed = await first.updateAgent({
        name: "Iris",
        aiProvider: "Gemini",
      });
      expect(renamed).toMatchObject({
        name: "Iris",
        aiProvider: "Gemini",
        model: null,
      });
      expect(await events()).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "communications",
        keys: ["name", "aiProvider"],
      });
    },
  ],
  [
    "gives the Communications Agent the default look until it is given an Avatar",
    async ({ communications, events }) => {
      const agent = communications();
      expect((await agent.agent()).avatar).toEqual(
        defaultCommunicationsAgentAvatar,
      );
      const look = {
        ...defaultCommunicationsAgentAvatar,
        hairstyle: "curly" as const,
        hairColour: "#b55239",
      };
      expect((await agent.updateAgent({ avatar: look })).avatar).toEqual(look);
      // Stored, so another start finds it.
      expect((await communications().agent()).avatar).toEqual(look);
      // The same look again changes nothing.
      await agent.updateAgent({ avatar: { ...look } });
      expect(
        (await events()).filter(
          (event) =>
            event.type === "config.changed" && event.scope === "communications",
        ),
      ).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "communications",
          keys: ["avatar"],
        },
      ]);
    },
  ],
  [
    "delivers an action Notice to a webhook once, signed, with its title, Floor, kind and links",
    async ({ communications, webhook, raiseNotice }) => {
      const server = await webhook();
      const agent = communications();
      await agent.add(
        webhookRequest("Team chat", server.url, { secret: signingSecret }),
      );
      const { id } = await raiseNotice({
        kind: "action",
        title: "PR #14 awaiting your approval",
        floorId: "web-shop",
        issue: {
          number: 4,
          url: "https://github.com/adrianeyre/web-shop/issues/4",
        },
        pullRequest: {
          number: 14,
          url: "https://github.com/adrianeyre/web-shop/pull/14",
        },
      });
      await agent.takeIn();
      await agent.takeIn();
      expect(await agent.deliverDue()).toBe(1);
      expect(await agent.deliverDue()).toBe(0);

      expect(server.received).toHaveLength(1);
      const [received] = server.received;
      if (received === undefined) {
        throw new Error("Nothing arrived.");
      }
      expect(
        verifySignature(
          received.raw,
          signingSecret,
          received.headers["x-ai-office-signature-256"] as string,
        ),
      ).toBe(true);
      expect(
        verifySignature(
          received.raw,
          "another-secret-0000",
          received.headers["x-ai-office-signature-256"] as string,
        ),
      ).toBe(false);
      expect(received.headers["content-type"]).toBe("application/json");
      const body = received.body as Record<string, unknown>;
      expect(body).toEqual({
        id: received.headers["x-ai-office-delivery"],
        test: false,
        kind: "action_notice",
        title: "PR #14 awaiting your approval",
        floor: { id: "web-shop", name: "Web shop" },
        links: {
          aiOffice: `${publicUrl}/notices?notice=${id}`,
          github: "https://github.com/adrianeyre/web-shop/pull/14",
        },
        occurredAt: start.toISOString(),
      });
      const [connection] = await agent.list();
      expect(connection?.lastDelivery).toMatchObject({
        status: "delivered",
        attempts: 1,
        test: false,
      });
    },
  ],
  [
    "sends what each Connection's rules let through: action Notices and work complete by default, info Notices when asked, and only its Floors",
    async ({ communications, webhook, raiseNotice, bus }) => {
      const everything = await webhook();
      const blogOnly = await webhook();
      const agent = communications();
      await agent.add(
        webhookRequest("Everything", everything.url, {
          rules: {
            actionNotices: true,
            infoNotices: true,
            workComplete: true,
            floorIds: [],
          },
        }),
      );
      await agent.add(
        webhookRequest("Blog", blogOnly.url, {
          rules: {
            actionNotices: true,
            infoNotices: false,
            workComplete: true,
            floorIds: ["blog"],
          },
        }),
      );
      await raiseNotice({
        kind: "info",
        title: "PR #12 opened",
        floorId: "web-shop",
      });
      await bus.publish(merged(15, 5));
      await raiseNotice({
        kind: "action",
        title: "Claude needs you to sign in again",
      });
      await agent.takeIn();
      await agent.deliverDue();

      expect(
        bodies(everything).map(({ kind, title }) => [kind, title]),
      ).toEqual([
        ["info_notice", "PR #12 opened"],
        ["work_complete", "Pull request #15 merged, closing issue #5"],
        ["action_notice", "Claude needs you to sign in again"],
      ]);
      expect(bodies(everything)[1]).toMatchObject({
        floor: { id: "web-shop", name: "Web shop" },
        links: {
          aiOffice: `${publicUrl}/activity?floorId=web-shop&issue=5`,
          github: "https://github.com/adrianeyre/web-shop/pull/15",
        },
      });
      // A Notice about the whole Office passes every Floor filter.
      expect(bodies(blogOnly).map(({ title }) => title)).toEqual([
        "Claude needs you to sign in again",
      ]);
    },
  ],
  [
    'a Batch finished is work complete: its Wrap-up\'s counts and a link to it on the whiteboard, and only its kind at "links only"',
    async ({ communications, webhook, bus }) => {
      const titled = await webhook();
      const linksOnly = await webhook();
      const quiet = await webhook();
      const agent = communications();
      await agent.add(webhookRequest("Titled", titled.url));
      await agent.add({
        ...webhookRequest("Links only", linksOnly.url),
        detailLevel: "links_only",
      });
      await agent.add(
        webhookRequest("No work complete", quiet.url, {
          rules: {
            actionNotices: true,
            infoNotices: false,
            workComplete: false,
            floorIds: [],
          },
        }),
      );
      await bus.publish({
        type: "batch.finished",
        version: 1,
        floorId: "web-shop",
        batchId: 3,
        agentId: "grace",
        agentIds: ["ada", "alan"],
        issues: [1, 3, 2, 4, 5],
        merged: 2,
        closed: 1,
        blocked: 1,
        notStarted: 1,
        tokens: 250_000,
      });
      await agent.takeIn();
      await agent.deliverDue();

      expect(bodies(titled)).toEqual([
        expect.objectContaining({
          kind: "work_complete",
          title:
            "Batch 3 finished: 2 of 5 issues merged, 1 closed, 1 blocked, 1 not started",
          floor: { id: "web-shop", name: "Web shop" },
          links: {
            aiOffice: `${publicUrl}/floors/web-shop/whiteboard?batch=3`,
            github: null,
          },
        }),
      ]);
      expect(bodies(linksOnly)).toEqual([
        expect.objectContaining({
          kind: "work_complete",
          title: "Work complete",
          floor: null,
          links: {
            aiOffice: `${publicUrl}/floors/web-shop/whiteboard?batch=3`,
            github: null,
          },
        }),
      ]);
      expect(quiet.received).toEqual([]);
    },
  ],
  [
    "retries a failed delivery with exponential backoff, and a restart mid-retry loses nothing",
    async ({ communications, webhook, bus, advance, store }) => {
      const server = await webhook();
      server.answerWith(500);
      const first = communications();
      const { id } = await first.add(webhookRequest("Team chat", server.url));
      await bus.publish(merged(14));
      await first.takeIn();
      expect(await first.deliverDue()).toBe(1);
      const [pending] = await first.deliveries(id);
      expect(pending).toMatchObject({
        status: "pending",
        attempts: 1,
        error: "The webhook answered 500.",
        nextAttemptAt: new Date(start.getTime() + 30_000),
      });
      // Not due yet.
      advance(29_000);
      expect(await first.deliverDue()).toBe(0);
      advance(1_000);
      expect(await first.deliverDue()).toBe(1);
      expect((await first.deliveries(id))[0]).toMatchObject({
        attempts: 2,
        nextAttemptAt: new Date(start.getTime() + 30_000 + 60_000),
      });
      await first.stop();

      // While AI Office is down, more happens.
      await bus.publish(merged(16));

      server.answerWith(204);
      advance(60_000);
      const second = communications();
      await second.start();
      await vi.waitFor(async () => {
        expect(
          (await store.deliveries(id, 10)).map(({ status }) => status),
        ).toEqual(["delivered", "delivered"]);
      });
      await second.stop();
      const titles = bodies(server).map(({ title }) => title);
      expect(titles).toEqual([
        "Pull request #14 merged, closing issue #4",
        "Pull request #14 merged, closing issue #4",
        "Pull request #14 merged, closing issue #4",
        "Pull request #16 merged, closing issue #6",
      ]);
      // Every attempt at one delivery carries its id, so repeats can be dropped.
      expect(
        new Set(
          server.received.map(({ headers }) => headers["x-ai-office-delivery"]),
        ).size,
      ).toBe(2);
    },
  ],
  [
    'five failures in a row raise one "Connection failing" Notice, never sent to that Connection, and its recovery is recorded',
    async ({ communications, webhook, bus, advance, events, notices }) => {
      const broken = await webhook();
      const working = await webhook();
      broken.answerWith(503);
      const agent = communications();
      const failing = await agent.add(webhookRequest("Broken", broken.url));
      await agent.add(webhookRequest("Working", working.url));
      await bus.publish(merged(14));
      await agent.takeIn();
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        await agent.deliverDue();
        await agent.takeIn();
        await agent.deliverDue();
        advance(60 * 60 * 1000);
      }
      expect(broken.received.length).toBe(6);
      const failingNotices = [...notices.values()].filter(({ title }) =>
        title.startsWith('Connection "Broken" is failing'),
      );
      expect(failingNotices).toHaveLength(1);
      expect(failingNotices[0]).toMatchObject({
        kind: "action",
        floorId: null,
        links: [
          {
            label: "Open the Connection",
            url: `${publicUrl}/general-settings/connections?connection=${failing.id}`,
          },
        ],
      });
      expect(await agent.get(failing.id)).toMatchObject({
        status: "failing",
        consecutiveFailures: 6,
      });
      // The other Connection is told; the failing one never is.
      expect(bodies(working).map(({ title }) => title)).toEqual([
        "Pull request #14 merged, closing issue #4",
        'Connection "Broken" is failing: 5 deliveries in a row failed',
      ]);
      expect(bodies(broken).every(({ kind }) => kind === "work_complete")).toBe(
        true,
      );
      expect(
        (await agent.deliveries(failing.id)).map(({ message }) => message.kind),
      ).toEqual(["work_complete"]);
      const feed = await events();
      expect(feed.filter(({ type }) => type === "connection.failing")).toEqual([
        {
          type: "connection.failing",
          version: 1,
          connectionId: failing.id,
          name: "Broken",
          failures: 5,
          noticeId: failingNotices[0]?.id,
        },
      ]);

      broken.answerWith(200);
      await agent.deliverDue();
      expect(await agent.get(failing.id)).toMatchObject({
        status: "ok",
        consecutiveFailures: 0,
      });
      expect(await events()).toContainEqual({
        type: "connection.recovered",
        version: 1,
        connectionId: failing.id,
        name: "Broken",
      });
    },
  ],
  [
    "gives a delivery up 24 hours after its first attempt, and respects Retry-After",
    async ({ communications, webhook, bus, advance, events }) => {
      const server = await webhook();
      server.answerWith(429, { "retry-after": "120" });
      const agent = communications();
      const { id } = await agent.add(webhookRequest("Team chat", server.url));
      await bus.publish(merged(14));
      await agent.takeIn();
      await agent.deliverDue();
      expect((await agent.deliveries(id))[0]?.nextAttemptAt).toEqual(
        new Date(start.getTime() + 120_000),
      );
      server.answerWith(500);
      let attempts = 1;
      for (let hour = 0; hour < 30; hour += 1) {
        advance(60 * 60 * 1000);
        attempts += await agent.deliverDue();
      }
      const [delivery] = await agent.deliveries(id);
      expect(delivery).toMatchObject({
        status: "failed",
        attempts,
        nextAttemptAt: null,
      });
      expect(
        (delivery?.lastAttemptAt?.getTime() ?? 0) - start.getTime(),
      ).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(await events()).toContainEqual({
        type: "connection.delivery_expired",
        version: 1,
        connectionId: id,
        name: "Team chat",
        deliveryId: delivery?.id,
        attempts,
      });
    },
  ],
  [
    "while the Communications Agent is paused nothing is sent, and deliveries queue until it resumes",
    async ({ communications, webhook, bus }) => {
      const server = await webhook();
      const agent = communications();
      await agent.add(webhookRequest("Team chat", server.url));
      await agent.updateAgent({ enabled: false });
      await bus.publish(merged(14));
      await bus.publish(merged(15));
      await agent.takeIn();
      expect(await agent.deliverDue()).toBe(0);
      expect(server.received).toHaveLength(0);
      await agent.updateAgent({ enabled: true });
      await vi.waitFor(() => {
        expect(server.received).toHaveLength(2);
      });
    },
  ],
  [
    "a paused Connection is sent nothing until it resumes; renaming, rules and removal are in the Activity Feed",
    async ({ communications, webhook, bus, events }) => {
      const server = await webhook();
      const agent = communications();
      const { id } = await agent.add(webhookRequest("Team chat", server.url));
      await agent.update(id, { paused: true });
      await bus.publish(merged(14));
      await agent.takeIn();
      await agent.deliverDue();
      expect(server.received).toHaveLength(0);
      await agent.update(id, { paused: false });
      await bus.publish(merged(15));
      await agent.takeIn();
      await agent.deliverDue();
      expect(bodies(server).map(({ title }) => title)).toEqual([
        "Pull request #15 merged, closing issue #5",
      ]);

      await agent.add(webhookRequest("Phone", server.url));
      await expect(agent.update(id, { name: "Phone" })).rejects.toMatchObject({
        code: "connection_name_taken",
      });
      await expect(
        agent.add(webhookRequest("Phone", server.url)),
      ).rejects.toBeInstanceOf(CommunicationsError);
      await agent.update(id, {
        name: "Ops chat",
        rules: {
          actionNotices: true,
          infoNotices: true,
          workComplete: false,
          floorIds: ["web-shop"],
        },
      });
      await agent.remove(id);
      await expect(agent.get(id)).rejects.toMatchObject({
        code: "connection_not_found",
      });
      const feed = (await events()).filter(({ type }) =>
        type.startsWith("connection."),
      );
      expect(feed).toEqual([
        {
          type: "connection.added",
          version: 1,
          connectionId: id,
          name: "Team chat",
          connectionType: "webhook",
        },
        {
          type: "connection.changed",
          version: 1,
          connectionId: id,
          name: "Team chat",
          keys: ["paused"],
          paused: true,
        },
        {
          type: "connection.changed",
          version: 1,
          connectionId: id,
          name: "Team chat",
          keys: ["paused"],
          paused: false,
        },
        expect.objectContaining({ type: "connection.added", name: "Phone" }),
        {
          type: "connection.changed",
          version: 1,
          connectionId: id,
          name: "Ops chat",
          keys: ["name", "rules"],
        },
        {
          type: "connection.removed",
          version: 1,
          connectionId: id,
          name: "Ops chat",
        },
      ]);
    },
  ],
  [
    "Send test sends at once and shows its result in the log, without counting towards failing",
    async ({ communications, webhook, advance }) => {
      const server = await webhook();
      const agent = communications();
      const { id } = await agent.add(webhookRequest("Team chat", server.url));
      const sent = await agent.sendTest(id);
      advance(1000);
      expect(sent).toMatchObject({ delivered: true, error: null });
      expect(bodies(server)[0]).toMatchObject({
        test: true,
        kind: "test",
        links: {
          aiOffice: `${publicUrl}/general-settings/connections?connection=${id}`,
          github: null,
        },
      });
      server.answerWith(401);
      const refused = await agent.sendTest(id);
      expect(refused).toMatchObject({
        delivered: false,
        error: "The webhook answered 401.",
      });
      expect(refused.connection).toMatchObject({
        status: "ok",
        consecutiveFailures: 0,
        lastDelivery: { test: true, status: "failed" },
      });
      expect((await agent.deliveries(id)).map(({ status }) => status)).toEqual([
        "failed",
        "delivered",
      ]);
      await server.close();
      const unreachable = await agent.sendTest(id);
      expect(unreachable.error).toMatch(/^The webhook could not be reached/);
      expect(unreachable.error).not.toContain("s3cr3t-webhook-path");
    },
  ],
  [
    "keeps credentials sealed at rest and never gives them back",
    async ({ communications, webhook, events, storedCredentials }) => {
      const server = await webhook();
      const agent = communications();
      const added = await agent.add(
        webhookRequest("Team chat", server.url, { secret: signingSecret }),
      );
      expect(added.hint).toBe(new URL(server.url).host);
      expect(added.details).toEqual(["Signed with HMAC-SHA256"]);
      const shown = JSON.stringify([
        added,
        await agent.list(),
        await agent.get(added.id),
        await agent.sendTest(added.id),
        await agent.deliveries(added.id),
        await events(),
      ]);
      expect(shown).not.toContain("s3cr3t-webhook-path");
      expect(shown).not.toContain(signingSecret);
      const sealed = await storedCredentials(added.id);
      if (sealed !== undefined) {
        expect(sealed).toMatch(/^aio1:/);
        expect(sealed).not.toContain("s3cr3t-webhook-path");
        expect(sealed).not.toContain(signingSecret);
        expect(
          JSON.parse(
            encryptor.decrypt(sealed, `connection.credentials:${added.id}`),
          ),
        ).toEqual({ url: server.url, secret: signingSecret });
      }
    },
  ],
];

describe("Communications, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const clock = { time: start };
      const store = memoryCommunicationsStore();
      await run(
        setUp(
          store,
          createEventBus({
            store: memoryEventStore(),
            now: () => clock.time,
          }),
          clock,
          () => Promise.resolve(undefined),
        ),
      );
    });
  }
});

describe("Communications, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const clock = { time: start };
      await run(
        setUp(
          databaseCommunicationsStore(database.db),
          createEventBus({
            store: databaseEventStore(database.db),
            now: () => clock.time,
          }),
          clock,
          async (id) => {
            const rows = await database.db
              .select({
                id: connections.id,
                credentials: connections.credentials,
              })
              .from(connections);
            return rows.find((row) => row.id === id)?.credentials;
          },
        ),
      );
    });
  }
});

describe("messages", () => {
  it("are the same for the same event: deterministic templates", async () => {
    const clock = { time: start };
    const bus = createEventBus({
      store: memoryEventStore(),
      now: () => clock.time,
    });
    const made: OutboundMessage[] = [];
    for (let run = 0; run < 2; run += 1) {
      const store = memoryCommunicationsStore();
      const server = await serveFakeWebhook();
      servers.push(server);
      const agent = setUp(store, bus, clock, () =>
        Promise.resolve(undefined),
      ).communications();
      await agent.add(webhookRequest("Team chat", server.url));
      clock.time = new Date(clock.time.getTime() + 1000);
      await bus.publish(merged(14));
      await agent.takeIn();
      const [connection] = await agent.list();
      const [delivery] = await store.deliveries(connection?.id ?? "", 1);
      if (delivery !== undefined) {
        made.push({ ...delivery.message, occurredAt: "" });
      }
    }
    expect(made).toHaveLength(2);
    expect(made[0]).toEqual(made[1]);
  });
});
