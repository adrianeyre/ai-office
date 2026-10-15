import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import {
  createRedactor,
  slackCredentialsSchema,
  type NewNotice,
  type OutboundMessage,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCommunications,
  type Communications,
} from "../communications.ts";
import { memoryCommunicationsStore } from "../store.ts";
import { serveFakeSlack, type FakeSlack } from "../testing.ts";
import { defaultTransports } from "./defaults.ts";
import { slackBlocks, slackTransport } from "./slack.ts";

// The Slack Connection's contract (PRD FR-91), against a fake Slack that
// answers as Slack's Web API and incoming webhooks do: both modes deliver
// a message in Slack's block format, with the title, Floor, kind and link
// buttons back to AI Office and GitHub; a 429 is retried after its
// Retry-After; and an invalid bot token makes the Connection failing.

const start = new Date("2026-10-10T09:00:00.000Z");
const publicUrl = "https://office.example.com";
const botToken = "xoxb-1111111111-fake-slack-token";

const slacks: FakeSlack[] = [];
afterEach(async () => {
  await Promise.all(slacks.splice(0).map((slack) => slack.close()));
});

interface Setup {
  readonly slack: FakeSlack;
  readonly bus: EventBus;
  readonly agent: Communications;
  readonly notices: string[];
  readonly advance: (ms: number) => void;
  readonly events: () => Promise<OfficeEvent[]>;
}

async function setUp(): Promise<Setup> {
  const slack = await serveFakeSlack({ botToken });
  slacks.push(slack);
  const clock = { time: start };
  const bus = createEventBus({
    store: memoryEventStore(),
    now: () => clock.time,
  });
  const notices: string[] = [];
  const raiseNotice = async (notice: NewNotice) => {
    const id = `notice-${String(notices.length + 1)}`;
    notices.push(notice.title);
    await bus.publish({
      type: "notice.raised",
      version: 1,
      noticeId: id,
      kind: notice.kind,
      title: notice.title,
    });
    return { id };
  };
  const agent = createCommunications({
    store: memoryCommunicationsStore(),
    events: bus,
    encryptor: encryptorFromKey(Buffer.alloc(32, 3)),
    transports: {
      ...defaultTransports(),
      slack: slackTransport({ apiUrl: slack.apiUrl, timeoutMs: 2000 }),
    },
    publicUrl,
    floorName: (floorId) =>
      Promise.resolve(floorId === "web-shop" ? "Web shop" : undefined),
    notice: () => Promise.resolve(undefined),
    raiseNotice,
    redactor: createRedactor(),
    now: () => clock.time,
  });
  return {
    slack,
    bus,
    agent,
    notices,
    advance(ms) {
      clock.time = new Date(clock.time.getTime() + ms);
    },
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const merged = {
  type: "pull_request.merged",
  version: 1,
  floorId: "web-shop",
  issue: 4,
  pullRequest: 14,
  url: "https://github.com/adrianeyre/web-shop/pull/14",
  sha: "b".repeat(40),
  by: "app",
} satisfies OfficeEvent;

const modes = {
  "an incoming webhook": (slack: FakeSlack) => ({
    mode: "webhook" as const,
    webhookUrl: slack.webhookUrl,
  }),
  "a bot token and a channel": () => ({
    mode: "bot" as const,
    botToken,
    channel: "#ops",
  }),
};

describe.each(Object.entries(modes))("Slack through %s", (_, credentials) => {
  it("sends a message in Slack's block format: title, Floor, kind and link buttons", async () => {
    const { slack, bus, agent } = await setUp();
    await agent.add({
      type: "slack",
      name: "Slack",
      credentials: credentials(slack),
    });
    await bus.publish(merged);
    await agent.takeIn();
    await agent.deliverDue();
    expect(slack.posts).toHaveLength(1);
    const [post] = slack.posts;
    expect(post).toEqual({
      via: credentials(slack).mode,
      channel: "#ops",
      text: "Web shop: Pull request #14 merged, closing issue #4",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Pull request #14 merged, closing issue #4*",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "*Floor:* Web shop  ·  *Kind:* Work complete",
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "ai_office",
              text: {
                type: "plain_text",
                text: "Open in AI Office",
                emoji: false,
              },
              url: `${publicUrl}/activity?floorId=web-shop&issue=4`,
            },
            {
              type: "button",
              action_id: "github",
              text: {
                type: "plain_text",
                text: "Open on GitHub",
                emoji: false,
              },
              url: "https://github.com/adrianeyre/web-shop/pull/14",
            },
          ],
        },
      ],
    });
  });

  it("waits for a 429's Retry-After before trying again", async () => {
    const { slack, bus, agent, advance } = await setUp();
    const { id } = await agent.add({
      type: "slack",
      name: "Slack",
      credentials: credentials(slack),
    });
    slack.rateLimit(1, 7);
    await bus.publish(merged);
    await agent.takeIn();
    await agent.deliverDue();
    expect(slack.rateLimited).toBe(1);
    expect(slack.posts).toHaveLength(0);
    expect((await agent.deliveries(id))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Slack is rate-limiting this Connection (429).",
      nextAttemptAt: new Date(start.getTime() + 7000),
    });
    advance(6000);
    expect(await agent.deliverDue()).toBe(0);
    advance(1000);
    expect(await agent.deliverDue()).toBe(1);
    expect(slack.posts).toHaveLength(1);
    expect((await agent.deliveries(id))[0]?.status).toBe("delivered");
  });

  it("sends a test message, and never gives its credentials back", async () => {
    const { slack, agent, events } = await setUp();
    const added = await agent.add({
      type: "slack",
      name: "Slack",
      credentials: credentials(slack),
    });
    expect(await agent.sendTest(added.id)).toMatchObject({
      delivered: true,
      error: null,
    });
    expect(slack.posts[0]?.text).toBe(
      "Test message from AI Office: this Connection works",
    );
    const shown = JSON.stringify([
      added,
      await agent.list(),
      await agent.deliveries(added.id),
      await events(),
    ]);
    expect(shown).not.toContain(botToken);
    expect(shown).not.toContain("fakeWebhookSecret");
  });
});

describe("a Slack bot", () => {
  it("with an invalid token makes the Connection failing after 5 tries, with a Notice", async () => {
    const { slack, bus, agent, advance, notices, events } = await setUp();
    const { id } = await agent.add({
      type: "slack",
      name: "Slack",
      credentials: {
        mode: "bot",
        botToken: "xoxb-2222222222-revoked-token",
        channel: "#ops",
      },
    });
    await bus.publish(merged);
    await agent.takeIn();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await agent.deliverDue();
      advance(60 * 60 * 1000);
    }
    expect(slack.posts).toHaveLength(0);
    expect(await agent.get(id)).toMatchObject({
      status: "failing",
      consecutiveFailures: 5,
    });
    expect((await agent.deliveries(id))[0]?.error).toBe(
      "Slack refused the bot token (invalid_auth).",
    );
    expect(notices).toEqual([
      'Connection "Slack" is failing: 5 deliveries in a row failed',
    ]);
    expect((await events()).map(({ type }) => type)).toContain(
      "connection.failing",
    );
    expect(JSON.stringify(await agent.deliveries(id))).not.toContain(
      "revoked-token",
    );
  });

  it("says when its channel is not found", async () => {
    const { slack, agent } = await setUp();
    const { id } = await agent.add({
      type: "slack",
      name: "Slack",
      credentials: { mode: "bot", botToken, channel: "#nowhere" },
    });
    expect(await agent.sendTest(id)).toMatchObject({
      delivered: false,
      error: "Slack refused the message (channel_not_found).",
    });
    expect(slack.posts).toHaveLength(0);
  });

  it("shows where it posts, and not its token", async () => {
    const { agent } = await setUp();
    const added = await agent.add({
      type: "slack",
      name: "Slack",
      credentials: { mode: "bot", botToken, channel: "C0123456789" },
    });
    expect(added).toMatchObject({
      hint: "bot token",
      details: ["Posts to C0123456789 as a bot"],
    });
  });
});

describe("an incoming webhook", () => {
  it("that Slack no longer knows is refused with its reason", async () => {
    const { slack, agent } = await setUp();
    const { id } = await agent.add({
      type: "slack",
      name: "Slack",
      credentials: {
        mode: "webhook",
        webhookUrl: slack.webhookUrl.replace("fakeWebhookSecret", "gone"),
      },
    });
    expect(await agent.sendTest(id)).toMatchObject({
      delivered: false,
      error: "Slack refused the message with 404 (no_service).",
    });
  });

  it("shows only its host", async () => {
    const { slack, agent } = await setUp();
    const added = await agent.add({
      type: "slack",
      name: "Slack",
      credentials: { mode: "webhook", webhookUrl: slack.webhookUrl },
    });
    expect(added.hint).toBe(new URL(slack.webhookUrl).host);
    expect(added.details).toEqual(["Incoming webhook"]);
  });
});

describe("slackBlocks", () => {
  const message: OutboundMessage = {
    kind: "action_notice",
    title: "Review <script> & co: ".padEnd(4000, "x"),
    floor: null,
    aiOfficeUrl: `${publicUrl}/notices?notice=n1`,
    githubUrl: null,
    occurredAt: start.toISOString(),
  };

  it("escapes Slack's markup and keeps within its limits, without a GitHub button when there is no link", () => {
    const { text, blocks } = slackBlocks(message, false);
    expect(text.length).toBeLessThanOrEqual(3000);
    const [section, context, actions] = blocks as {
      text?: { text: string };
      elements: { text: string | { text: string } }[];
    }[];
    expect(
      section?.text?.text.startsWith("*Review &lt;script&gt; &amp; co: "),
    ).toBe(true);
    expect(section?.text?.text.length).toBeLessThanOrEqual(3000);
    expect(context?.elements[0]?.text).toBe("*Kind:* Action Notice");
    expect(actions?.elements).toHaveLength(1);
  });
});

describe("Slack's credentials", () => {
  it("take a bot token and a channel or user, or an incoming webhook", () => {
    expect(
      slackCredentialsSchema
        .safeParse({
          mode: "bot",
          botToken: "not-a-token",
          channel: "#ops",
        })
        .error?.issues.map(({ message }) => message),
    ).toEqual(["A bot token starts xoxb- (or xoxp- for a user token)."]);
    expect(
      slackCredentialsSchema.safeParse({
        mode: "bot",
        botToken,
        channel: "ops channel",
      }).success,
    ).toBe(false);
    expect(
      slackCredentialsSchema.safeParse({
        mode: "bot",
        botToken,
        channel: "U0ABCDEF1",
      }).success,
    ).toBe(true);
  });
});
