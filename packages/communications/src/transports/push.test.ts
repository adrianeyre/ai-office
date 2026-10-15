import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import {
  createRedactor,
  ntfyCredentialsSchema,
  pushoverCredentialsSchema,
  type NewNotice,
  type OutboundMessage,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCommunications,
  type Communications,
} from "../communications.ts";
import type { NoticeView } from "../messages.ts";
import { memoryCommunicationsStore } from "../store.ts";
import {
  serveFakeNtfy,
  serveFakePushover,
  type FakeNtfy,
  type FakePushover,
} from "../testing.ts";
import { defaultTransports } from "./defaults.ts";
import { ntfyTransport } from "./ntfy.ts";
import { pushoverFields, pushoverTransport } from "./pushover.ts";

// The phone push Connections' contract (PRD FR-91), against a fake ntfy
// server and a fake Pushover that answer as theirs do: action Notices go
// at high priority, tapping one opens it in AI Office, and an invalid
// token fails each delivery, so 5 in a row make the Connection failing.

const start = new Date("2026-10-10T09:00:00.000Z");
const publicUrl = "https://office.example.com";
const ntfyToken = "tk_fakentfytoken0123456789abcdef";
const pushoverToken = "azGDORePK8gMaC0QOYAMyEEuzJnyUi";
const userKey = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG";
const pullRequestUrl = "https://github.com/adrianeyre/web-shop/pull/14";

const servers: (FakeNtfy | FakePushover)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Setup {
  readonly ntfy: FakeNtfy;
  readonly pushover: FakePushover;
  readonly bus: EventBus;
  readonly agent: Communications;
  readonly notices: string[];
  readonly advance: (ms: number) => void;
  readonly events: () => Promise<OfficeEvent[]>;
}

/** The Notice that awaits the Owner's approval of PR #14. */
const awaiting: NoticeView = {
  id: "notice-awaiting",
  kind: "action",
  title: "PR #14 awaiting your approval",
  floorId: "web-shop",
  issue: { url: "https://github.com/adrianeyre/web-shop/issues/4" },
  pullRequest: { url: pullRequestUrl },
  ciRunUrl: null,
  links: [],
};

async function setUp(): Promise<Setup> {
  const ntfy = await serveFakeNtfy({
    accessToken: ntfyToken,
    protectedTopics: ["private-office"],
  });
  const pushover = await serveFakePushover({
    applicationToken: pushoverToken,
    userKeys: [userKey],
  });
  servers.push(ntfy, pushover);
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
    encryptor: encryptorFromKey(Buffer.alloc(32, 7)),
    transports: {
      ...defaultTransports(),
      ntfy: ntfyTransport({ timeoutMs: 2000 }),
      pushover: pushoverTransport({
        apiUrl: pushover.apiUrl,
        timeoutMs: 2000,
      }),
    },
    publicUrl,
    floorName: (floorId) =>
      Promise.resolve(floorId === "web-shop" ? "Web shop" : undefined),
    notice: (noticeId) =>
      Promise.resolve(noticeId === awaiting.id ? awaiting : undefined),
    raiseNotice,
    redactor: createRedactor(),
    now: () => clock.time,
  });
  return {
    ntfy,
    pushover,
    bus,
    agent,
    notices,
    advance(ms) {
      clock.time = new Date(clock.time.getTime() + ms);
    },
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const actionNotice = {
  type: "notice.raised",
  version: 1,
  noticeId: awaiting.id,
  kind: "action",
  title: awaiting.title,
  floorId: "web-shop",
} satisfies OfficeEvent;

const merged = {
  type: "pull_request.merged",
  version: 1,
  floorId: "web-shop",
  issue: 4,
  pullRequest: 14,
  url: pullRequestUrl,
  sha: "d".repeat(40),
  by: "app",
} satisfies OfficeEvent;

const noticeLink = `${publicUrl}/notices?notice=${awaiting.id}`;
const activityLink = `${publicUrl}/activity?floorId=web-shop&issue=4`;

/** Publishes `events`, then sends what they queued. */
async function deliver(setup: Setup, ...events: OfficeEvent[]) {
  for (const event of events) {
    await setup.bus.publish(event);
  }
  await setup.agent.takeIn();
  await setup.agent.deliverDue();
}

/** Five failed attempts, an hour apart. */
async function failFiveTimes(setup: Setup) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await setup.agent.deliverDue();
    setup.advance(60 * 60 * 1000);
  }
}

describe("ntfy", () => {
  it("sends an action Notice at high priority, opening the Notice in AI Office when tapped", async () => {
    const setup = await setUp();
    await setup.agent.add({
      type: "ntfy",
      name: "Phone",
      credentials: { server: setup.ntfy.url, topic: "ai-office-owner" },
    });
    await deliver(setup, actionNotice);
    expect(setup.ntfy.notifications).toEqual([
      {
        topic: "ai-office-owner",
        title: "PR #14 awaiting your approval",
        message: "Web shop · Action Notice",
        priority: 4,
        click: noticeLink,
        actions: [
          {
            action: "view",
            label: "Open on GitHub",
            url: pullRequestUrl,
            clear: false,
          },
        ],
      },
    ]);
  });

  it("sends work complete at the default priority", async () => {
    const setup = await setUp();
    await setup.agent.add({
      type: "ntfy",
      name: "Phone",
      credentials: { server: setup.ntfy.url, topic: "ai-office-owner" },
    });
    await deliver(setup, merged);
    expect(setup.ntfy.notifications).toMatchObject([
      {
        title: "Pull request #14 merged, closing issue #4",
        message: "Web shop · Work complete",
        priority: 3,
        click: activityLink,
      },
    ]);
  });

  it("publishes to a topic that needs it with the access token", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add({
      type: "ntfy",
      name: "Phone",
      credentials: {
        server: `${setup.ntfy.url}/`,
        topic: "private-office",
        accessToken: ntfyToken,
      },
    });
    expect(await setup.agent.sendTest(id)).toMatchObject({
      delivered: true,
      error: null,
    });
    expect(setup.ntfy.notifications).toMatchObject([
      {
        topic: "private-office",
        title: "Test message from AI Office: this Connection works",
        message: "Test",
        priority: 3,
        click: `${publicUrl}/general-settings/connections?connection=${id}`,
      },
    ]);
  });

  it("with an invalid token makes the Connection failing after 5 tries, with a Notice", async () => {
    const setup = await setUp();
    const revoked = "tk_revokedtoken0123456789abcdefg";
    const { id } = await setup.agent.add({
      type: "ntfy",
      name: "Phone",
      credentials: {
        server: setup.ntfy.url,
        topic: "private-office",
        accessToken: revoked,
      },
    });
    await setup.bus.publish(actionNotice);
    await setup.agent.takeIn();
    await failFiveTimes(setup);
    expect(setup.ntfy.notifications).toHaveLength(0);
    expect(await setup.agent.get(id)).toMatchObject({
      status: "failing",
      consecutiveFailures: 5,
    });
    expect((await setup.agent.deliveries(id))[0]?.error).toBe(
      "ntfy refused the access token (401).",
    );
    expect(setup.notices).toEqual([
      'Connection "Phone" is failing: 5 deliveries in a row failed',
    ]);
    expect((await setup.events()).map(({ type }) => type)).toContain(
      "connection.failing",
    );
    const shown = JSON.stringify([
      await setup.agent.list(),
      await setup.agent.deliveries(id),
      await setup.events(),
    ]);
    expect(shown).not.toContain(revoked);
    expect(shown).not.toContain("private-office");
  });

  it("says when a topic needs an access token", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add({
      type: "ntfy",
      name: "Phone",
      credentials: { server: setup.ntfy.url, topic: "private-office" },
    });
    expect(await setup.agent.sendTest(id)).toMatchObject({
      delivered: false,
      error: "ntfy needs an access token to publish to this topic (403).",
    });
  });

  it("waits for a 429's Retry-After before trying again", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add({
      type: "ntfy",
      name: "Phone",
      credentials: { server: setup.ntfy.url, topic: "ai-office-owner" },
    });
    setup.ntfy.rateLimit(1, 9);
    await deliver(setup, merged);
    expect(setup.ntfy.rateLimited).toBe(1);
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "pending",
      error: "ntfy is rate-limiting this Connection (429).",
      nextAttemptAt: new Date(start.getTime() + 9000),
    });
    setup.advance(9000);
    expect(await setup.agent.deliverDue()).toBe(1);
    expect(setup.ntfy.notifications).toHaveLength(1);
  });

  it("shows its server and whether it signs in, never its topic or token", async () => {
    const setup = await setUp();
    const added = await setup.agent.add({
      type: "ntfy",
      name: "Phone",
      credentials: {
        server: "https://ntfy.example.com",
        topic: "secret-topic-4471",
        accessToken: ntfyToken,
      },
    });
    expect(added).toMatchObject({
      type: "ntfy",
      hint: "ntfy.example.com",
      details: ["Publishes with an access token"],
    });
    const shown = JSON.stringify(await setup.agent.list());
    expect(shown).not.toContain("secret-topic-4471");
    expect(shown).not.toContain(ntfyToken);
  });

  it("checks its server, topic and token", () => {
    const problems = (value: unknown) =>
      ntfyCredentialsSchema
        .safeParse(value)
        .error?.issues.map(({ message }) => message);
    expect(
      problems({ server: "https://ntfy.sh", topic: "ai-office" }),
    ).toBeUndefined();
    expect(problems({ server: "ftp://ntfy.sh", topic: "ai-office" })).toEqual([
      "Give the ntfy server's address, such as https://ntfy.sh.",
    ]);
    expect(problems({ server: "https://ntfy.sh", topic: "a/b" })).toEqual([
      "A topic is 1 to 64 letters, digits, hyphens and underscores.",
    ]);
    expect(
      problems({
        server: "https://ntfy.sh",
        topic: "ai-office",
        accessToken: "not-a-token",
      }),
    ).toEqual(["An access token starts tk_ and has 32 characters."]);
  });
});

describe("Pushover", () => {
  it("sends an action Notice at high priority, its link opening the Notice in AI Office", async () => {
    const setup = await setUp();
    await setup.agent.add({
      type: "pushover",
      name: "Pushover",
      credentials: { applicationToken: pushoverToken, userKey },
    });
    await deliver(setup, actionNotice);
    expect(setup.pushover.messages).toEqual([
      {
        user: userKey,
        title: "PR #14 awaiting your approval",
        message: `Web shop · Action Notice\nGitHub: ${pullRequestUrl}`,
        priority: 1,
        url: noticeLink,
        urlTitle: "Open in AI Office",
        timestamp: start.getTime() / 1000,
      },
    ]);
  });

  it("sends work complete at normal priority", async () => {
    const setup = await setUp();
    await setup.agent.add({
      type: "pushover",
      name: "Pushover",
      credentials: { applicationToken: pushoverToken, userKey },
    });
    await deliver(setup, merged);
    expect(setup.pushover.messages).toMatchObject([
      {
        title: "Pull request #14 merged, closing issue #4",
        priority: 0,
        url: activityLink,
      },
    ]);
  });

  it("with an invalid application token makes the Connection failing after 5 tries, with a Notice", async () => {
    const setup = await setUp();
    const wrongToken = "a".repeat(15) + "B".repeat(15);
    const { id } = await setup.agent.add({
      type: "pushover",
      name: "Pushover",
      credentials: { applicationToken: wrongToken, userKey },
    });
    await setup.bus.publish(actionNotice);
    await setup.agent.takeIn();
    await failFiveTimes(setup);
    expect(setup.pushover.messages).toHaveLength(0);
    expect(await setup.agent.get(id)).toMatchObject({
      status: "failing",
      consecutiveFailures: 5,
    });
    expect((await setup.agent.deliveries(id))[0]?.error).toBe(
      "Pushover refused the application token (400).",
    );
    expect(setup.notices).toEqual([
      'Connection "Pushover" is failing: 5 deliveries in a row failed',
    ]);
    const shown = JSON.stringify([
      await setup.agent.list(),
      await setup.agent.deliveries(id),
      await setup.events(),
    ]);
    expect(shown).not.toContain(wrongToken);
    expect(shown).not.toContain(userKey);
  });

  it("says when the user key is refused", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add({
      type: "pushover",
      name: "Pushover",
      credentials: {
        applicationToken: pushoverToken,
        userKey: "u".repeat(30),
      },
    });
    expect(await setup.agent.sendTest(id)).toMatchObject({
      delivered: false,
      error: "Pushover refused the user key (400).",
    });
  });

  it("shows the start of its user key only", async () => {
    const setup = await setUp();
    const added = await setup.agent.add({
      type: "pushover",
      name: "Pushover",
      credentials: { applicationToken: pushoverToken, userKey },
    });
    expect(added).toMatchObject({
      hint: "user key uQiR…",
      details: ["Pushover"],
    });
    const shown = JSON.stringify(await setup.agent.list());
    expect(shown).not.toContain(pushoverToken);
    expect(shown).not.toContain(userKey);
  });

  it("keeps within Pushover's limits", () => {
    const message: OutboundMessage = {
      kind: "info_notice",
      title: "x".repeat(400),
      floor: null,
      aiOfficeUrl: `${publicUrl}/notices?notice=n1`,
      githubUrl: null,
      occurredAt: start.toISOString(),
    };
    const fields = pushoverFields(message, false);
    expect(fields["title"]).toHaveLength(250);
    expect(fields["message"]).toBe("Info Notice");
    expect(fields["priority"]).toBe("0");
  });

  it("checks its application token and user key", () => {
    expect(
      pushoverCredentialsSchema
        .safeParse({ applicationToken: "short", userKey })
        .error?.issues.map(({ message }) => message),
    ).toEqual(["The application token is 30 letters and digits."]);
  });
});
