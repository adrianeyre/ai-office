import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import {
  createRedactor,
  emailCredentialsSchema,
  type EmailCredentials,
  type NewNotice,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCommunications,
  type Communications,
} from "../communications.ts";
import { mailpitAccount, mailpitTest } from "../mailpit.ts";
import { memoryCommunicationsStore } from "../store.ts";
import { serveFakeSmtp, type FakeSmtp } from "../testing.ts";
import { defaultTransports } from "./defaults.ts";
import { emailContent, emailTransport } from "./email.ts";

// The email Connection's contract (PRD FR-91, §9): over SMTP, as plain
// text and HTML with links back to AI Office and GitHub, to one or more
// addresses; a refused sign-in fails like any delivery, so 5 in a row make
// the Connection failing. The contract runs against Mailpit (skipped,
// with the reason, without Docker) and against a small in-process fake
// SMTP server, which runs anywhere.

const start = new Date("2026-10-10T09:00:00.000Z");
const publicUrl = "https://office.example.com";

/** A message as the SMTP server received it. */
interface Received {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly deliveryId: string | undefined;
}

/** An SMTP server to send to, and what it received. */
interface SmtpServer {
  readonly host: string;
  readonly port: number;
  readonly account: { readonly username: string; readonly password: string };
  readonly received: () => Promise<Received[]>;
}

interface Setup {
  readonly bus: EventBus;
  readonly agent: Communications;
  readonly notices: string[];
  readonly advance: (ms: number) => void;
  readonly events: () => Promise<OfficeEvent[]>;
}

function setUp(): Setup {
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
  return {
    bus,
    notices,
    agent: createCommunications({
      store: memoryCommunicationsStore(),
      events: bus,
      encryptor: encryptorFromKey(Buffer.alloc(32, 5)),
      transports: {
        ...defaultTransports(),
        email: emailTransport({ timeoutMs: 5000 }),
      },
      publicUrl,
      floorName: (floorId) =>
        Promise.resolve(floorId === "web-shop" ? "Web shop" : undefined),
      notice: () => Promise.resolve(undefined),
      raiseNotice,
      redactor: createRedactor(),
      now: () => clock.time,
    }),
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
  sha: "c".repeat(40),
  by: "owner",
} satisfies OfficeEvent;

const credentialsFor = (
  server: SmtpServer,
  overrides: Partial<EmailCredentials> = {},
): EmailCredentials => ({
  host: server.host,
  port: server.port,
  tls: "none",
  username: server.account.username,
  password: server.account.password,
  from: "ai-office@example.com",
  to: ["owner@example.com"],
  ...overrides,
});

type Case = readonly [string, (server: SmtpServer) => Promise<void>];

const cases: Case[] = [
  [
    "sends each message as plain text and HTML, with links back to AI Office and GitHub",
    async (server) => {
      const { bus, agent } = setUp();
      const { id } = await agent.add({
        type: "email",
        name: "Email",
        credentials: credentialsFor(server),
      });
      await bus.publish(merged);
      await agent.takeIn();
      await agent.deliverDue();
      const [delivery] = await agent.deliveries(id);
      expect(delivery?.status).toBe("delivered");
      const received = await server.received();
      expect(received).toHaveLength(1);
      const [message] = received;
      expect(message).toMatchObject({
        from: "ai-office@example.com",
        to: ["owner@example.com"],
        subject:
          "[AI Office] Web shop: Pull request #14 merged, closing issue #4",
        deliveryId: delivery?.id,
      });
      const aiOffice = `${publicUrl}/activity?floorId=web-shop&issue=4`;
      const github = "https://github.com/adrianeyre/web-shop/pull/14";
      expect(message?.text).toContain(
        "Pull request #14 merged, closing issue #4",
      );
      expect(message?.text).toContain("Floor: Web shop");
      expect(message?.text).toContain("Kind: Work complete");
      expect(message?.text).toContain(`Open in AI Office: ${aiOffice}`);
      expect(message?.text).toContain(`Open on GitHub: ${github}`);
      expect(message?.html).toContain(
        `<a href="${aiOffice.replaceAll("&", "&amp;")}">Open in AI Office</a>`,
      );
      expect(message?.html).toContain(`<a href="${github}">Open on GitHub</a>`);
      expect(message?.html).toContain("<strong>Floor:</strong> Web shop");
    },
  ],
  [
    "sends one message to several addresses",
    async (server) => {
      const { agent } = setUp();
      const { id } = await agent.add({
        type: "email",
        name: "Email",
        credentials: credentialsFor(server, {
          to: ["owner@example.com", "ops@example.com", "pager@example.org"],
        }),
      });
      expect(await agent.sendTest(id)).toMatchObject({
        delivered: true,
        error: null,
      });
      const received = await server.received();
      expect(received).toHaveLength(1);
      expect([...(received[0]?.to ?? [])].sort()).toEqual([
        "ops@example.com",
        "owner@example.com",
        "pager@example.org",
      ]);
      expect(received[0]?.subject).toBe(
        "[AI Office] Test message from AI Office: this Connection works",
      );
    },
  ],
  [
    "a refused sign-in fails each delivery, and 5 in a row make the Connection failing",
    async (server) => {
      const { bus, agent, advance, notices, events } = setUp();
      const wrongPassword = "not-the-password-0451";
      const { id } = await agent.add({
        type: "email",
        name: "Email",
        credentials: credentialsFor(server, { password: wrongPassword }),
      });
      const test = await agent.sendTest(id);
      expect(test.delivered).toBe(false);
      expect(test.error).toMatch(
        /^The SMTP server refused the username or password( \(535\))?\.$/,
      );
      await bus.publish(merged);
      await agent.takeIn();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await agent.deliverDue();
        advance(60 * 60 * 1000);
      }
      expect(await agent.get(id)).toMatchObject({
        status: "failing",
        consecutiveFailures: 5,
      });
      expect(notices).toEqual([
        'Connection "Email" is failing: 5 deliveries in a row failed',
      ]);
      expect((await events()).map(({ type }) => type)).toContain(
        "connection.failing",
      );
      expect(await server.received()).toHaveLength(0);
      const shown = JSON.stringify([
        await agent.list(),
        await agent.deliveries(id),
        await events(),
      ]);
      expect(shown).not.toContain(wrongPassword);
      expect(shown).not.toContain(server.account.password);
    },
  ],
];

describe("email, against Mailpit", () => {
  for (const [name, run] of cases) {
    mailpitTest(name, async ({ mailpit }) => {
      await run({
        host: mailpit.host,
        port: mailpit.smtpPort,
        account: mailpitAccount,
        received: async () =>
          (await mailpit.messages()).map((message) => ({
            from: message.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
            // Mailpit spells header names its own way.
            deliveryId: Object.entries(message.headers).find(
              ([header]) => header.toLowerCase() === "x-ai-office-delivery",
            )?.[1][0],
          })),
      });
    });
  }
});

/** Decodes a MIME part's body. */
const decodePart = (body: string, encoding: string | undefined): string =>
  encoding?.toLowerCase() === "base64"
    ? Buffer.from(body.replaceAll(/\s/g, ""), "base64").toString("utf8")
    : encoding?.toLowerCase() === "quoted-printable"
      ? Buffer.from(
          body
            .replaceAll("=\r\n", "")
            .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            ),
          "latin1",
        ).toString("utf8")
      : body;

/** A message's headers (unfolded, lower-cased names) and body. */
const split = (raw: string) => {
  const end = raw.indexOf("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of raw
    .slice(0, end)
    .replaceAll(/\r\n[ \t]+/g, " ")
    .split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(
      line.slice(0, colon).toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return { headers, body: raw.slice(end + 4) };
};

/** The plain text and HTML of a multipart/alternative message. */
function parseMessage(raw: string) {
  const { headers, body } = split(raw);
  const boundary = /boundary="?([^";]+)"?/.exec(
    headers.get("content-type") ?? "",
  )?.[1];
  const parts = (boundary === undefined ? [] : body.split(`--${boundary}`))
    .map((part) => part.replace(/^\r\n/, ""))
    .filter((part) => part.includes("\r\n\r\n"))
    .map(split);
  const part = (type: string) => {
    const found = parts.find(({ headers: partHeaders }) =>
      (partHeaders.get("content-type") ?? "").startsWith(type),
    );
    return found === undefined
      ? ""
      : decodePart(
          found.body.replace(/\r\n$/, ""),
          found.headers.get("content-transfer-encoding"),
        );
  };
  return {
    subject: headers.get("subject") ?? "",
    deliveryId: headers.get("x-ai-office-delivery"),
    text: part("text/plain").replaceAll("\r\n", "\n"),
    html: part("text/html").replaceAll("\r\n", "\n"),
  };
}

describe("email, against a fake SMTP server in this process", () => {
  const servers: FakeSmtp[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  for (const [name, run] of cases) {
    it(name, async () => {
      const smtp = await serveFakeSmtp(mailpitAccount);
      servers.push(smtp);
      await run({
        host: smtp.host,
        port: smtp.port,
        account: mailpitAccount,
        received: () =>
          Promise.resolve(
            smtp.messages.map((message) => ({
              from: message.from,
              to: message.to,
              ...parseMessage(message.data),
            })),
          ),
      });
    });
  }

  it("says when the SMTP server cannot be reached", async () => {
    const smtp = await serveFakeSmtp(mailpitAccount);
    await smtp.close();
    const { agent } = setUp();
    const { id } = await agent.add({
      type: "email",
      name: "Email",
      credentials: {
        host: smtp.host,
        port: smtp.port,
        tls: "none",
        from: "ai-office@example.com",
        to: ["owner@example.com"],
      },
    });
    expect((await agent.sendTest(id)).error).toBe(
      "The SMTP server could not be reached (ESOCKET).",
    );
  });
});

describe("an email Connection", () => {
  it("shows its server, TLS, sign-in and addresses, never its password", async () => {
    const { agent } = setUp();
    const added = await agent.add({
      type: "email",
      name: "Email",
      credentials: {
        host: "smtp.example.com",
        port: 587,
        tls: "starttls",
        username: "ai-office@example.com",
        password: "app-password-9f8e7d",
        from: "ai-office@example.com",
        to: ["owner@example.com", "ops@example.com"],
      },
    });
    expect(added).toMatchObject({
      type: "email",
      hint: "smtp.example.com:587",
      details: [
        "TLS: STARTTLS",
        "Signs in as ai-office@example.com",
        "From ai-office@example.com",
        "To owner@example.com, ops@example.com",
      ],
    });
    expect(JSON.stringify(await agent.list())).not.toContain(
      "app-password-9f8e7d",
    );
  });

  it("takes a username and a password together, and at least one address", () => {
    const base = {
      host: "smtp.example.com",
      port: 465,
      tls: "tls",
      from: "ai-office@example.com",
      to: ["owner@example.com"],
    };
    expect(emailCredentialsSchema.safeParse(base).success).toBe(true);
    expect(
      emailCredentialsSchema
        .safeParse({ ...base, username: "someone" })
        .error?.issues.map(({ message }) => message),
    ).toEqual(["Give both a username and a password, or neither."]);
    expect(
      emailCredentialsSchema
        .safeParse({ ...base, to: [] })
        .error?.issues.map(({ message }) => message),
    ).toEqual(["Give at least one address to send to."]);
    expect(
      emailCredentialsSchema
        .safeParse({ ...base, to: ["not an address"] })
        .error?.issues.map(({ message }) => message),
    ).toEqual(["Give each address as name@example.com."]);
  });

  it("escapes what it puts in its HTML, and keeps its subject to one line", () => {
    const { subject, html } = emailContent(
      {
        kind: "action_notice",
        title: 'Review <b>"this"</b>\r\nBcc: someone@example.com',
        floor: null,
        aiOfficeUrl: `${publicUrl}/notices?notice=n1&x=<y>`,
        githubUrl: null,
        occurredAt: start.toISOString(),
      },
      false,
    );
    expect(subject).toBe(
      '[AI Office] Review <b>"this"</b> Bcc: someone@example.com',
    );
    expect(html).toContain(
      "<strong>Review &lt;b&gt;&quot;this&quot;&lt;/b&gt;",
    );
    expect(html).toContain(
      `<a href="${publicUrl}/notices?notice=n1&amp;x=&lt;y&gt;">Open in AI Office</a>`,
    );
    expect(html).not.toContain("Open on GitHub");
  });
});
