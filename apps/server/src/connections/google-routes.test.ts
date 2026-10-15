import {
  createCommunications,
  createGoogleAuth,
  databaseCommunicationsStore,
  defaultTransports,
  googleSheetsTransport,
  memoryCommunicationsStore,
  type CommunicationsStore,
} from "@ai-office/communications";
import {
  serveFakeGoogle,
  type FakeGoogle,
} from "@ai-office/communications/testing";
import { googleSignIn as googleSignInTable } from "@ai-office/db";
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
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  connectionSchema,
  connectionTestResultSchema,
  createRedactor,
  googleRedirectPath,
  googleSignInSchema,
  googleSignInStartSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  type SignedIn,
} from "../test-support.ts";

// The Google sign-in API (PRD FR-91, FR-93): the OAuth client entered and
// its secret never sent back; a sign-in begun, the Owner consenting on (a
// fake) Google, and finished with what the redirect brought back; a Google
// Sheets Connection then writing its test row; and signing out revoking
// the grant. No answer, log line or event holds the secret, a token or the
// code. Each case runs in memory and in Postgres 18.

const publicUrl = "https://office.example.com";
const clientId = "1234567890-routes.apps.googleusercontent.com";
const clientSecret = "GOCSPX-routesClientSecret0123456789";
const spreadsheetId = "1RoutesSpreadsheet0123456789abcdefghijkl";

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
  readonly google: FakeGoogle;
  readonly logs: string[];
  /** The Google sign-in as kept, whichever store keeps it. */
  stored(): Promise<unknown>;
}

const fakes: FakeGoogle[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function setUp(
  stores: OfficeStores,
  store: CommunicationsStore,
  bus: EventBus,
  stored: Setup["stored"],
): Promise<Setup> {
  const logs: string[] = [];
  const redactor = createRedactor();
  const google = await serveFakeGoogle({
    clientId,
    clientSecret,
    redirectUri: `${publicUrl}${googleRedirectPath}`,
    spreadsheets: [{ id: spreadsheetId, tabs: ["Work log"] }],
  });
  fakes.push(google);
  const notices = createNotices({
    store: stores.notices,
    events: bus,
    redactor,
  });
  const auth = createGoogleAuth({
    store,
    events: bus,
    encryptor: testEncryptor,
    publicUrl,
    endpoints: google.endpoints,
    redactor,
  });
  const communications = createCommunications({
    store,
    events: bus,
    encryptor: testEncryptor,
    transports: {
      ...defaultTransports({ google: auth }),
      google_sheets: googleSheetsTransport({
        google: auth,
        apiUrl: google.sheetsUrl,
      }),
    },
    publicUrl,
    floorName: async (floorId) => (await stores.floors.get(floorId))?.name,
    notice: (id) => notices.get(id).catch(() => undefined),
    raiseNotice: (notice) => notices.raise(notice),
    google: auth,
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
    google: auth,
    publicUrl,
    redactor,
  });
  return {
    server,
    owner: await signIn(server),
    bus,
    google,
    logs,
    stored,
  };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

type Case = readonly [string, (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "signs in through the API with the Google Connections' scopes, and never answers, logs or publishes a secret, token or code",
    async (setup) => {
      const before = googleSignInSchema.parse(
        (await request(setup, "GET", "/api/google")).json(),
      );
      expect(before).toMatchObject({
        status: "not_configured",
        clientId: null,
        redirectUri: `${publicUrl}/admin/connections/google`,
      });

      // A malformed client is refused, naming the field.
      const malformed = await request(setup, "PUT", "/api/google/client", {
        clientId: "not-a-client",
        clientSecret,
      });
      expect(malformed.statusCode).toBe(400);
      const entered = await request(setup, "PUT", "/api/google/client", {
        clientId,
        clientSecret,
      });
      expect(entered.statusCode).toBe(200);
      expect(googleSignInSchema.parse(entered.json())).toMatchObject({
        status: "signed_out",
        clientId,
        services: [],
      });

      // Nothing to ask for until there is a Google Connection.
      const early = await request(setup, "POST", "/api/google/sign-in");
      expect(early.statusCode).toBe(409);
      expect(apiErrorSchema.parse(early.json()).error).toBe(
        "google_no_services",
      );
      const added = await request(setup, "POST", "/api/connections", {
        type: "google_sheets",
        name: "Work log",
        credentials: {
          spreadsheetId: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
          tab: "Work log",
        },
      });
      expect(added.statusCode).toBe(201);
      const connection = connectionSchema.parse(added.json());
      expect(connection).toMatchObject({
        type: "google_sheets",
        details: [`Spreadsheet ${spreadsheetId}`, 'Tab "Work log"'],
        rules: { floorIds: [], notices: false },
      });

      const started = await request(setup, "POST", "/api/google/sign-in");
      expect(started.statusCode).toBe(200);
      const { url } = googleSignInStartSchema.parse(started.json());
      const back = setup.google.consent(url);
      expect(setup.google.consents[0]?.scopes).toEqual([
        "https://www.googleapis.com/auth/spreadsheets",
      ]);
      // A forged state is refused; the real one finishes it.
      const forged = await request(
        setup,
        "POST",
        "/api/google/sign-in/complete",
        { code: back.code, state: "forged" },
      );
      expect(forged.statusCode).toBe(404);
      const completed = await request(
        setup,
        "POST",
        "/api/google/sign-in/complete",
        { code: back.code, state: back.state },
      );
      expect(completed.statusCode).toBe(200);
      expect(googleSignInSchema.parse(completed.json())).toMatchObject({
        status: "signed_in",
        services: ["sheets"],
        grantedScopes: ["https://www.googleapis.com/auth/spreadsheets"],
        missingServices: [],
      });

      // Send test writes a test row through the sign-in.
      const tested = connectionTestResultSchema.parse(
        (
          await request(setup, "POST", `/api/connections/${connection.id}/test`)
        ).json(),
      );
      expect(tested).toMatchObject({ delivered: true, error: null });
      expect(setup.google.rows(spreadsheetId, "Work log")).toHaveLength(2);

      // Signing out revokes the grant at Google.
      const out = await request(setup, "DELETE", "/api/google/sign-in");
      expect(googleSignInSchema.parse(out.json()).status).toBe("signed_out");
      expect(setup.google.revoked).toHaveLength(1);

      const secrets = [
        clientSecret,
        back.code ?? "",
        ...setup.google.issuedTokens,
      ];
      expect(secrets.length).toBeGreaterThan(3);
      const answers = JSON.stringify([
        entered.json(),
        completed.json(),
        (await request(setup, "GET", "/api/google")).json(),
      ]);
      const events = JSON.stringify(await setup.bus.history({ limit: 500 }));
      const logs = setup.logs.join("\n");
      const kept = JSON.stringify(await setup.stored());
      for (const secret of secrets) {
        expect(answers).not.toContain(secret);
        expect(events).not.toContain(secret);
        expect(logs).not.toContain(secret);
        expect(kept).not.toContain(secret);
      }
      expect(events).toContain('"type":"google.signed_in"');
      expect(events).toContain('"type":"google.signed_out"');
    },
  ],
];

describe("the Google sign-in API, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const store = memoryCommunicationsStore();
      const setup = await setUp(
        memoryStores(),
        store,
        createEventBus({ store: memoryEventStore() }),
        () => store.googleSignIn(),
      );
      try {
        await run(setup);
      } finally {
        await setup.server.close();
      }
    });
  }
});

describe("the Google sign-in API, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        databaseCommunicationsStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
        () => database.db.select().from(googleSignInTable),
      );
      try {
        await run(setup);
      } finally {
        await setup.server.close();
      }
    });
  }
});
