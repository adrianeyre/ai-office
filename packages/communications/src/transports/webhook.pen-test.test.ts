import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  allowInternalHosts,
  allowedInternalHosts,
  confluenceCredentialsSchema,
  emailCredentialsSchema,
  ntfyCredentialsSchema,
  slackCredentialsSchema,
  webhookCredentialsSchema,
} from "@ai-office/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confluenceTransport } from "./confluence.ts";
import { emailTransport } from "./email.ts";
import { ntfyTransport } from "./ntfy.ts";
import { slackTransport } from "./slack.ts";

import { DeliveryError } from "./transport.ts";
import { webhookTransport } from "./webhook.ts";

// I1 probe (pen-testing, "Infrastructure and delivery"): the generic webhook
// Connection (FR-91) as an Owner-triggered fetch to an internal address
// (H13). The Owner sets the URL, so the attacker is position 4 (a stolen
// session that adds or edits a Connection). See
// docs/pen-testing/assessments/I1.md.
//
// This is a blind SSRF: the webhook POSTs AI Office's message to any http or
// https address, and nothing blocks a loopback, the EC2 metadata service, a
// private address or a bare internal name (app:3047, postgres:3048). The
// answer's body is not returned (FR-95: nothing coming back is acted on),
// but the response *status* is reflected to the Owner through the delivery
// error, and whether a connection succeeded is itself an oracle for what is
// listening inside the stack.
//
// Fixed (I1-2, ADR 0007): the same host policy as I1-1. A webhook, and
// every other address a Connection is sent to, may not name an internal
// host unless ALLOWED_INTERNAL_HOSTS does, and is never connected to: the
// delivery says why, the same whether anything listens or not. The
// package's tests allow loopback for their fakes (`test-setup.ts`); here,
// as AI Office starts, nothing is allowed.

const transport = webhookTransport({ timeoutMs: 2000 });

const servers: Server[] = [];
/** The hosts the package's tests allow, put back after each test. */
const testsAllow = allowedInternalHosts();

beforeEach(() => {
  // As AI Office starts: ALLOWED_INTERNAL_HOSTS names nothing.
  allowInternalHosts([]);
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  allowInternalHosts(testsAllow);
});

/** A local service standing in for an internal one (app:3047, Postgres…). */
async function internalService(
  handle: (request: IncomingMessage) => { status: number },
): Promise<{ url: string; received: IncomingMessage[] }> {
  const received: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    received.push(request);
    request.resume();
    request.on("end", () => {
      response.writeHead(handle(request).status).end("internal-only-secret");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, received };
}

const delivery = {
  id: "i1-delivery-1",
  connectionId: "conn-1",
  test: false as const,
  message: {
    kind: "action_notice" as const,
    title: "A pull request awaits your approval",
    floor: { id: "web-shop", name: "web-shop" },
    aiOfficeUrl: "https://ai-office.example/notices/1",
    githubUrl: null,
    occurredAt: "2026-10-11T12:00:00.000Z",
  },
};

const send = (url: string) =>
  transport.send(delivery, {
    credentials: { url },
    settings: { signed: false },
  });

/** Hosts a webhook should arguably never be allowed to reach. */
const internalWebhooks = [
  "http://127.0.0.1:3047/v1/messages",
  "http://169.254.169.254/latest/meta-data/",
  "http://localhost:3048/",
  "https://[::1]/",
  "http://10.0.0.5/",
  "http://app:3047/",
  "http://postgres:3048/",
];

describe("I1-2 (H13): a webhook Connection may be aimed at an internal address", () => {
  it("regression (I1-2): the webhook URL schema no longer accepts loopback, the metadata service, private addresses, bare names or plain http", () => {
    for (const url of internalWebhooks) {
      const parsed = webhookCredentialsSchema.safeParse({ url });
      expect(parsed.success, url).toBe(false);
      expect(parsed.error?.issues[0]?.message, url).toContain(
        "ALLOWED_INTERNAL_HOSTS",
      );
    }
    expect(
      webhookCredentialsSchema.safeParse({ url: "http://hooks.example.com/" })
        .success,
    ).toBe(false);
    expect(
      webhookCredentialsSchema.safeParse({ url: "https://hooks.example.com/" })
        .success,
    ).toBe(true);
  });

  it("regression (I1-2): the webhook no longer POSTs to a loopback service, nor reflects its status: the delivery says the host is internal", async () => {
    const service = await internalService(() => ({ status: 502 }));

    await expect(send(service.url)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DeliveryError &&
        !error.message.includes("502") &&
        error.message ===
          "The webhook is on an internal address (127.0.0.1), which AI Office reaches only if ALLOWED_INTERNAL_HOSTS names it.",
    );
    // It never reached the internal service.
    expect(service.received).toHaveLength(0);
  });

  it("regression (I1-2): whether the internal host answers is no longer an oracle — an open port and a closed one fail alike, and neither is connected to", async () => {
    const open = await internalService(() => ({ status: 204 }));
    const closedPort = open.url.replace(/:\d+/, ":1");

    const failures = await Promise.all(
      [open.url, closedPort].map((url) =>
        send(url).then(
          () => "delivered",
          (error: unknown) => (error as Error).message,
        ),
      ),
    );

    expect(failures[0]).toBe(failures[1]);
    expect(failures[0]).not.toContain("could not be reached");
    expect(open.received).toHaveLength(0);
  });

  it("a webhook Connection cannot be aimed at a loopback, link-local or private address", () => {
    const refused = internalWebhooks.filter(
      (url) => !webhookCredentialsSchema.safeParse({ url }).success,
    );
    // The property: every internal host is refused.
    expect(refused).toEqual(internalWebhooks);
  });

  it("a webhook on a host the Owner allowed is delivered, over http too", async () => {
    const service = await internalService(() => ({ status: 204 }));
    allowInternalHosts(["127.0.0.1"]);

    expect(
      webhookCredentialsSchema.safeParse({ url: service.url }).success,
    ).toBe(true);
    await expect(send(service.url)).resolves.toBeUndefined();
    expect(service.received).toHaveLength(1);
  });

  it("a webhook stored before, or a name that resolves to an internal address, is refused when it is sent", async () => {
    // `localhost` resolves to loopback; the schema refuses it, and so does
    // the send, which never trusts what was stored.
    const service = await internalService(() => ({ status: 204 }));
    const byName = service.url.replace("127.0.0.1", "localhost");
    await expect(send(byName)).rejects.toThrow(
      /internal address \(localhost\)/,
    );
    expect(service.received).toHaveLength(0);
  });
});

describe("I1-2 siblings: every other address a Connection is sent to", () => {
  const message = delivery;

  it("the schemas refuse an internal Slack webhook, ntfy server, Confluence site and SMTP server", () => {
    expect(
      slackCredentialsSchema.safeParse({
        mode: "webhook",
        webhookUrl: "http://169.254.169.254/latest/meta-data/",
      }).success,
    ).toBe(false);
    expect(
      ntfyCredentialsSchema.safeParse({
        server: "http://app:3047",
        topic: "office",
      }).success,
    ).toBe(false);
    expect(
      confluenceCredentialsSchema.safeParse({
        siteUrl: "http://postgres:3048",
        email: "owner@example.com",
        apiToken: "not-a-real-token",
        spaceKey: "ENG",
        parentPageId: "1",
      }).success,
    ).toBe(false);
    for (const host of [
      "127.0.0.1",
      "localhost",
      "postgres",
      "[::1]",
      "10.0.0.5",
    ]) {
      expect(
        emailCredentialsSchema.safeParse({
          host,
          port: 25,
          tls: "none",
          from: "office@example.com",
          to: ["owner@example.com"],
        }).success,
        host,
      ).toBe(false);
    }
  });

  it("each transport refuses to send to an internal host, never connecting", async () => {
    const service = await internalService(() => ({ status: 200 }));
    const port = new URL(service.url).port;
    const refusals = [
      slackTransport({ timeoutMs: 2000 }).send(message, {
        credentials: { mode: "webhook", webhookUrl: `${service.url}/hook` },
        settings: {},
      }),
      ntfyTransport({ timeoutMs: 2000 }).send(message, {
        credentials: { server: service.url, topic: "office" },
        settings: {},
      }),
      confluenceTransport({ timeoutMs: 2000 }).send(message, {
        credentials: {
          siteUrl: service.url,
          email: "owner@example.com",
          apiToken: "not-a-real-token",
          spaceKey: "ENG",
          parentPageId: "1",
        },
        settings: {},
      }),
      emailTransport({ timeoutMs: 2000 }).send(message, {
        credentials: {
          host: "127.0.0.1",
          port: Number(port),
          tls: "none",
          from: "office@example.com",
          to: ["owner@example.com"],
        },
        settings: {},
      }),
    ];
    for (const refusal of refusals) {
      await expect(refusal).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DeliveryError &&
          error.message.includes("internal address (127.0.0.1)"),
      );
    }
    expect(service.received).toHaveLength(0);
  });
});
