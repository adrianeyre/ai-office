import {
  createCommunications,
  databaseCommunicationsStore,
  defaultTransports,
  memoryCommunicationsStore,
  verifySignature,
  type Communications,
  type CommunicationsStore,
} from "@ai-office/communications";
import {
  serveFakeWebhook,
  type FakeWebhook,
} from "@ai-office/communications/testing";
import { connections as connectionsTable } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createNotices,
  databaseStores,
  memoryStores,
  type Notices,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  communicationsAgentSchema,
  defaultCommunicationsAgentAvatar,
  connectionDeliveryListSchema,
  connectionListSchema,
  connectionSchema,
  connectionTestResultSchema,
  createRedactor,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  type SignedIn,
} from "../test-support.ts";

// The Connections API (PRD FR-90, FR-93, FR-94): the Communications
// Agent's config; Connections added, renamed, given rules, paused,
// resumed, tested and deleted; and their credentials stored sealed and
// never sent back, in an answer, an event or a log line. An action Notice
// raised in the Office reaches a webhook Connection once, signed. Each
// case runs in memory and in Postgres 18.

const signingSecret = "whsec-routes-0123456789abcdef";

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
  readonly notices: Notices;
  readonly communications: Communications;
  readonly webhook: FakeWebhook;
  readonly logs: string[];
  /** The sealed credentials as kept, whichever store keeps them. */
  storedCredentials(id: string): Promise<string | undefined>;
}

const servers: FakeWebhook[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setUp(
  stores: OfficeStores,
  store: CommunicationsStore,
  bus: EventBus,
  storedCredentials: Setup["storedCredentials"],
): Promise<Setup> {
  const logs: string[] = [];
  const redactor = createRedactor();
  const notices = createNotices({
    store: stores.notices,
    events: bus,
    redactor,
  });
  const communications = createCommunications({
    store,
    events: bus,
    encryptor: testEncryptor,
    transports: defaultTransports(),
    publicUrl: "https://office.example.com",
    floorName: async (floorId) => (await stores.floors.get(floorId))?.name,
    notice: (id) => notices.get(id).catch(() => undefined),
    raiseNotice: (notice) => notices.raise(notice),
    redactor,
  });
  const server = await buildApp({
    logger: createLogger({
      level: "trace",
      secrets: [],
      redactor,
      destination: { write: (line: string) => logs.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    notices,
    communications,
    redactor,
  });
  const webhook = await serveFakeWebhook();
  servers.push(webhook);
  return {
    server,
    owner: await signIn(server),
    bus,
    notices,
    communications,
    webhook,
    logs,
    storedCredentials,
  };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const addWebhook = async (setup: Setup, name = "Team chat") => {
  const response = await request(setup, "POST", "/api/connections", {
    type: "webhook",
    name,
    credentials: { url: setup.webhook.url, secret: signingSecret },
  });
  expect(response.statusCode).toBe(201);
  return connectionSchema.parse(response.json());
};

type Case = readonly [string, (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "stores credentials sealed and never answers, logs or publishes them",
    async (setup) => {
      const added = await addWebhook(setup);
      expect(added).toMatchObject({
        name: "Team chat",
        type: "webhook",
        hint: new URL(setup.webhook.url).host,
        details: ["Signed with HMAC-SHA256"],
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: true,
          floorIds: [],
        },
        detailLevel: "titles_and_summaries",
        paused: false,
        status: "ok",
        lastDelivery: null,
      });
      const listed = await request(setup, "GET", "/api/connections");
      const tested = await request(
        setup,
        "POST",
        `/api/connections/${added.id}/test`,
      );
      const log = await request(
        setup,
        "GET",
        `/api/connections/${added.id}/deliveries`,
      );
      const everything = JSON.stringify([
        added,
        listed.json(),
        tested.json(),
        log.json(),
        await setup.bus.eventsAfter(0),
        setup.logs,
      ]);
      expect(everything).not.toContain("s3cr3t-webhook-path");
      expect(everything).not.toContain(signingSecret);
      const sealed = await setup.storedCredentials(added.id);
      expect(sealed).toMatch(/^aio1:/);
      expect(sealed).not.toContain("s3cr3t-webhook-path");
      expect(sealed).not.toContain(signingSecret);
      expect(setup.logs.join("\n")).toContain("A Connection was added.");
    },
  ],
  [
    "adds Confluence and Notion publishing destinations: their credentials never answered, their rules only Floors and a changelog",
    async (setup) => {
      const apiToken = "ATATT3xFfGF0-confluence-api-token-0123456789";
      const notionToken = "ntn_fakeNotionIntegrationToken0123456789AB";
      const confluence = await request(setup, "POST", "/api/connections", {
        type: "confluence",
        name: "Wiki",
        rules: {
          actionNotices: true,
          infoNotices: true,
          workComplete: true,
          floorIds: [],
          changelog: true,
        },
        credentials: {
          siteUrl: "https://example.atlassian.net",
          email: "owner@example.com",
          apiToken,
          spaceKey: "ENG",
          parentPageId: "123456",
        },
      });
      expect(confluence.statusCode).toBe(201);
      expect(connectionSchema.parse(confluence.json())).toMatchObject({
        type: "confluence",
        hint: "example.atlassian.net",
        details: ["Space ENG, under page 123456", "As owner@example.com"],
        rules: {
          actionNotices: false,
          infoNotices: false,
          workComplete: false,
          floorIds: [],
          changelog: true,
        },
      });
      const notion = await request(setup, "POST", "/api/connections", {
        type: "notion",
        name: "Notes",
        credentials: {
          token: notionToken,
          parentType: "database",
          parentId: "AAAABBBB-CCCC-DDDD-EEEE-FFFF00001111",
        },
      });
      expect(notion.statusCode).toBe(201);
      expect(connectionSchema.parse(notion.json())).toMatchObject({
        type: "notion",
        details: ["In database aaaabbbbccccddddeeeeffff00001111"],
        rules: { changelog: false },
      });
      const refused = await request(setup, "POST", "/api/connections", {
        type: "notion",
        name: "Bad",
        credentials: { token: "nope", parentType: "page", parentId: "x" },
      });
      expect(refused.statusCode).toBe(400);
      const everything = JSON.stringify([
        confluence.json(),
        notion.json(),
        (await request(setup, "GET", "/api/connections")).json(),
        await setup.bus.eventsAfter(0),
        setup.logs,
      ]);
      expect(everything).not.toContain(apiToken);
      expect(everything).not.toContain(notionToken);
    },
  ],
  [
    "adds Google Docs, Slides and Drive by a folder's address: only Docs keeps a changelog",
    async (setup) => {
      const folder = "1DocsFolder_AbCdEfGhIjKlMnOpQrStUv";
      const rules = {
        actionNotices: true,
        infoNotices: true,
        workComplete: true,
        floorIds: [],
        changelog: true,
      };
      for (const [type, changelog] of [
        ["google_docs", true],
        ["google_slides", false],
        ["google_drive", false],
      ] as const) {
        const added = await request(setup, "POST", "/api/connections", {
          type,
          name: type,
          rules,
          credentials: {
            folderId: `https://drive.google.com/drive/folders/${folder}?usp=sharing`,
          },
        });
        expect(added.statusCode).toBe(201);
        expect(connectionSchema.parse(added.json())).toMatchObject({
          type,
          hint: "Folder 1DocsFol…",
          details: [`In folder ${folder}`],
          rules: {
            actionNotices: false,
            infoNotices: false,
            workComplete: false,
            floorIds: [],
            changelog,
          },
        });
      }
      const refused = await request(setup, "POST", "/api/connections", {
        type: "google_drive",
        name: "Not a folder",
        credentials: {
          folderId: "https://docs.google.com/document/d/x/edit",
        },
      });
      expect(refused.statusCode).toBe(400);
    },
  ],
  [
    "adds Google Calendar by a calendar's address: its Floors only, and no changelog",
    async (setup) => {
      const calendarId = "c_0123456789abcdef@group.calendar.google.com";
      const added = await request(setup, "POST", "/api/connections", {
        type: "google_calendar",
        name: "Batches",
        rules: {
          actionNotices: true,
          infoNotices: true,
          workComplete: true,
          floorIds: ["web-shop"],
          changelog: true,
        },
        credentials: {
          calendarId: `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calendarId)}`,
        },
      });
      expect(added.statusCode).toBe(201);
      expect(connectionSchema.parse(added.json())).toMatchObject({
        type: "google_calendar",
        hint: "Calendar c_0123456789…",
        details: [`On calendar ${calendarId}`],
        rules: {
          actionNotices: false,
          infoNotices: false,
          workComplete: false,
          floorIds: ["web-shop"],
          changelog: false,
        },
      });
      const refused = await request(setup, "POST", "/api/connections", {
        type: "google_calendar",
        name: "Not a calendar",
        credentials: { calendarId: "https://calendar.google.com/calendar/r" },
      });
      expect(refused.statusCode).toBe(400);
    },
  ],
  [
    "sends a test and answers its result, which the log keeps",
    async (setup) => {
      const added = await addWebhook(setup);
      const sent = connectionTestResultSchema.parse(
        (
          await request(setup, "POST", `/api/connections/${added.id}/test`)
        ).json(),
      );
      expect(sent).toMatchObject({
        delivered: true,
        error: null,
        connection: { lastDelivery: { test: true, status: "delivered" } },
      });
      setup.webhook.answerWith(403);
      const refused = connectionTestResultSchema.parse(
        (
          await request(setup, "POST", `/api/connections/${added.id}/test`)
        ).json(),
      );
      expect(refused).toMatchObject({
        delivered: false,
        error: "The webhook answered 403.",
      });
      const { deliveries } = connectionDeliveryListSchema.parse(
        (
          await request(setup, "GET", `/api/connections/${added.id}/deliveries`)
        ).json(),
      );
      expect(deliveries.map(({ status }) => status).sort()).toEqual([
        "delivered",
        "failed",
      ]);
    },
  ],
  [
    "renames, edits rules, pauses, resumes and deletes a Connection",
    async (setup) => {
      const added = await addWebhook(setup);
      await addWebhook(setup, "Phone");
      const renamed = await request(
        setup,
        "PATCH",
        `/api/connections/${added.id}`,
        {
          name: "Ops chat",
          rules: {
            actionNotices: true,
            infoNotices: true,
            workComplete: false,
            floorIds: [],
          },
        },
      );
      expect(renamed.statusCode).toBe(200);
      expect(connectionSchema.parse(renamed.json())).toMatchObject({
        name: "Ops chat",
        rules: { infoNotices: true, workComplete: false },
      });
      const taken = await request(
        setup,
        "PATCH",
        `/api/connections/${added.id}`,
        { name: "Phone" },
      );
      expect(taken.statusCode).toBe(409);
      expect(apiErrorSchema.parse(taken.json()).error).toBe(
        "connection_name_taken",
      );
      const paused = await request(
        setup,
        "PATCH",
        `/api/connections/${added.id}`,
        { paused: true },
      );
      expect(connectionSchema.parse(paused.json()).paused).toBe(true);
      const resumed = await request(
        setup,
        "PATCH",
        `/api/connections/${added.id}`,
        { paused: false },
      );
      expect(connectionSchema.parse(resumed.json()).paused).toBe(false);
      const deleted = await request(
        setup,
        "DELETE",
        `/api/connections/${added.id}`,
      );
      expect(deleted.statusCode).toBe(204);
      const gone = await request(
        setup,
        "DELETE",
        `/api/connections/${added.id}`,
      );
      expect(gone.statusCode).toBe(404);
      const { connections } = connectionListSchema.parse(
        (await request(setup, "GET", "/api/connections")).json(),
      );
      expect(connections.map(({ name }) => name)).toEqual(["Phone"]);
      const types = (await setup.bus.eventsAfter(0))
        .map(({ event }) => event.type)
        .filter((type) => type.startsWith("connection."));
      expect(types).toEqual([
        "connection.added",
        "connection.added",
        "connection.changed",
        "connection.changed",
        "connection.changed",
        "connection.removed",
      ]);
    },
  ],
  [
    "an action Notice raised in the Office reaches a webhook Connection once, signed",
    async (setup) => {
      await addWebhook(setup);
      await setup.communications.start();
      try {
        const notice = await setup.notices.raise({
          kind: "action",
          title: "Claude needs you to sign in again",
        });
        await setup.notices.raise({ kind: "info", title: "Not sent" });
        await vi.waitFor(() => {
          expect(setup.webhook.received).toHaveLength(1);
        });
        const [received] = setup.webhook.received;
        expect(
          verifySignature(
            received?.raw ?? "",
            signingSecret,
            received?.headers["x-ai-office-signature-256"] as string,
          ),
        ).toBe(true);
        expect(received?.body).toMatchObject({
          kind: "action_notice",
          title: "Claude needs you to sign in again",
          links: {
            aiOffice: `https://office.example.com/notices?notice=${notice.id}`,
          },
        });
        await setup.communications.takeIn();
        await setup.communications.deliverDue();
        expect(setup.webhook.received).toHaveLength(1);
      } finally {
        await setup.communications.stop();
      }
    },
  ],
  [
    "shows and edits the Communications Agent",
    async (setup) => {
      const agent = communicationsAgentSchema.parse(
        (await request(setup, "GET", "/api/communications-agent")).json(),
      );
      expect(agent).toMatchObject({
        role: "communications",
        avatar: defaultCommunicationsAgentAvatar,
        aiProvider: "Claude",
        enabled: true,
      });
      // Its Avatar, as the lobby's reception desk shows it (FR-96).
      const look = { ...agent.avatar, hairstyle: "afro" };
      const restyled = await request(
        setup,
        "PATCH",
        "/api/communications-agent",
        { avatar: look },
      );
      expect(communicationsAgentSchema.parse(restyled.json()).avatar).toEqual(
        look,
      );
      const unknownLook = await request(
        setup,
        "PATCH",
        "/api/communications-agent",
        { avatar: { ...look, hairstyle: "mohawk" } },
      );
      expect(unknownLook.statusCode).toBe(400);
      const paused = await request(
        setup,
        "PATCH",
        "/api/communications-agent",
        {
          name: "Iris",
          enabled: false,
        },
      );
      expect(communicationsAgentSchema.parse(paused.json())).toMatchObject({
        name: "Iris",
        enabled: false,
      });
      const invalid = await request(
        setup,
        "PATCH",
        "/api/communications-agent",
        { aiProvider: "Jev" },
      );
      expect(invalid.statusCode).toBe(400);
    },
  ],
  [
    "refuses a Connection without a valid address, an unknown one, and anyone signed out",
    async (setup) => {
      const invalid = await request(setup, "POST", "/api/connections", {
        type: "webhook",
        name: "Team chat",
        credentials: { url: "ftp://example.com/hook" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(apiErrorSchema.parse(invalid.json()).problems).toEqual([
        "Give the webhook's address, starting https:// (or http://).",
      ]);
      const unknown = await request(
        setup,
        "POST",
        "/api/connections/connection-nope/test",
      );
      expect(unknown.statusCode).toBe(404);
      const signedOut = await setup.server.inject({
        method: "GET",
        url: "/api/connections",
      });
      expect(signedOut.statusCode).toBe(401);
    },
  ],
];

describe("the Connections API, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const store = memoryCommunicationsStore();
      const setup = await setUp(
        memoryStores(),
        store,
        createEventBus({ store: memoryEventStore() }),
        async (id) => (await store.connection(id))?.credentials,
      );
      try {
        await run(setup);
      } finally {
        await setup.server.close();
      }
    });
  }
});

describe("the Connections API, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        databaseCommunicationsStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
        async (id) => {
          const rows = await database.db.select().from(connectionsTable);
          return rows.find((row) => row.id === id)?.credentials;
        },
      );
      try {
        await run(setup);
      } finally {
        await setup.server.close();
      }
    });
  }
});
