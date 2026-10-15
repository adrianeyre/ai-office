import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createRedactor, googleRedirectPath } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCommunications,
  type Communications,
} from "../communications.ts";
import { createGoogleAuth, type GoogleAuth } from "../google.ts";
import type { BatchReport } from "../report.ts";
import { memoryCommunicationsStore } from "../store.ts";
import {
  serveFakeGoogle,
  type FakeCalendarEvent,
  type FakeGoogle,
} from "../testing.ts";
import { defaultTransports } from "./defaults.ts";
import { calendarEventId, googleCalendarTransport } from "./google-calendar.ts";
import { googleDocsTransport } from "./google-docs.ts";

// The Google Calendar Connection's contract (PRD FR-91, FR-92, FR-94,
// FR-95), against a fake Google whose Calendar API answers as Google's
// does: each Batch is one event on the Connection's calendar, made when
// the Batch starts and changed to its finish when it finishes, its
// description linking to its Plan and saying its outcome; never a second
// one, when an answer is lost and a delivery tried again, when the start
// is delivered after the finish, or when the Owner deleted it; each at its
// Connection's detail level, redacted, what a title says only ever text;
// signing in asks for `calendar.events` and no more; and "Send test" only
// reads the calendar.

const startedAt = new Date("2026-10-10T09:00:00.000Z");
const finishedAt = new Date("2026-10-10T10:50:00.000Z");
const publicUrl = "https://office.example.com";
const clientId = "1234567890-abcdefghijklmnop.apps.googleusercontent.com";
const clientSecret = "GOCSPX-fakeClientSecret0123456789ab";
const calendarId = "c_0123456789abcdef@group.calendar.google.com";
const otherCalendarId = "c_fedcba9876543210@group.calendar.google.com";
const docsFolder = "1DocsFolder_AbCdEfGhIjKlMnOpQrStUv";
const calendarScope = "https://www.googleapis.com/auth/calendar.events";
const driveScope = "https://www.googleapis.com/auth/drive";
const anthropicKey = "sk-ant-api03-pastedintoanissue-Qw3Er4Ty5Ui6Op7As8Df9";
const pull = (number: number) =>
  `https://github.com/adrianeyre/web-shop/pull/${String(number)}`;
const issueUrl = (number: number) =>
  `https://github.com/adrianeyre/web-shop/issues/${String(number)}`;
const planUrl = `${publicUrl}/floors/web-shop/whiteboard?batch=3`;
const hour = 60 * 60 * 1000;

/** Batch 3 on web-shop, as AI Office keeps its Wrap-up. */
const batchReport: BatchReport = {
  batchId: 3,
  floor: {
    id: "web-shop",
    name: "Web shop",
    repository: "adrianeyre/web-shop",
  },
  startedAt,
  finishedAt,
  planVersion: 2,
  issues: [
    {
      issue: 1,
      title: "Add a basket",
      agent: "Ada",
      dependsOn: [],
      outcome: "merged",
      pullRequest: { number: 11, url: pull(11) },
      rounds: { review: 2, qa: 1 },
      tokens: 150_000,
      estimatedCostUsd: 1.5,
    },
    {
      // A title is untrusted text: a planted key, HTML that would add a
      // link to the description, and Markdown that would add one too.
      issue: 2,
      title: `Show the total <a href="https://evil.example">click</a> **now** [here](https://evil.example) ${anthropicKey}`,
      agent: "Alan",
      dependsOn: [1],
      outcome: "blocked",
      pullRequest: { number: 12, url: pull(12) },
      rounds: { review: 3, qa: 0 },
      tokens: 90_000,
      estimatedCostUsd: 0.9,
    },
    {
      issue: 4,
      title: "Pay at checkout",
      agent: null,
      dependsOn: [2],
      outcome: "not_started",
      pullRequest: null,
      rounds: { review: 0, qa: 0 },
      tokens: 0,
      estimatedCostUsd: 0,
    },
  ],
  parallel: [[1], [2], [4]],
  leftOut: [],
  totals: {
    merged: 1,
    closed: 0,
    blocked: 1,
    notStarted: 1,
    tokens: 240_000,
    estimatedCostUsd: 2.4,
  },
};

const started = (batchId = 3, floorId = "web-shop") =>
  ({
    type: "batch.started",
    version: 1,
    floorId,
    batchId,
    agentId: "grace",
    issues: [1],
  }) satisfies OfficeEvent;

const finished = (batchId = 3, floorId = "web-shop") =>
  ({
    type: "batch.finished",
    version: 1,
    floorId,
    batchId,
    agentId: "grace",
    agentIds: ["ada", "alan"],
    issues: [1, 2, 4],
    merged: 1,
    closed: 0,
    blocked: 1,
    notStarted: 1,
    tokens: 240_000,
  }) satisfies OfficeEvent;

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Setup {
  readonly google: FakeGoogle;
  readonly auth: GoogleAuth;
  readonly bus: EventBus;
  readonly agent: Communications;
  /** Moves the clock on. */
  readonly advance: (ms: number) => void;
  /** Moves the clock to `at`. */
  readonly at: (at: Date) => void;
  /** Takes every event in, and sends what is due. */
  readonly run: () => Promise<void>;
  /** Plays the Owner through the consent screen, approving it (or `grant` only). */
  readonly signIn: (grant?: readonly string[]) => Promise<void>;
  /** Adds a Google Calendar Connection, by `calendar`'s address. */
  readonly addCalendar: (
    name: string,
    extra?: Record<string, unknown>,
    calendar?: string,
  ) => ReturnType<Communications["add"]>;
}

async function setUp(): Promise<Setup> {
  const clock = { time: startedAt };
  const now = () => clock.time;
  const google = await serveFakeGoogle({
    clientId,
    clientSecret,
    redirectUri: `${publicUrl}${googleRedirectPath}`,
    spreadsheets: [],
    folders: [{ id: docsFolder, name: "Wrap-up documents" }],
    calendars: [calendarId, otherCalendarId],
    now,
  });
  servers.push(google);
  const bus = createEventBus({ store: memoryEventStore(), now });
  const store = memoryCommunicationsStore();
  const encryptor = encryptorFromKey(Buffer.alloc(32, 9));
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
  await auth.configure({ clientId, clientSecret });
  const apis = { google: auth, ...google.apiUrls, timeoutMs: 2000 };
  const agent = createCommunications({
    store,
    events: bus,
    encryptor,
    transports: {
      ...defaultTransports({ google: auth }),
      google_docs: googleDocsTransport(apis),
      google_calendar: googleCalendarTransport(apis),
    },
    publicUrl,
    floorName: (floorId) =>
      Promise.resolve(floorId === "web-shop" ? "Web shop" : undefined),
    notice: () => Promise.resolve(undefined),
    raiseNotice: () => Promise.resolve({ id: "notice-1" }),
    batchReport: (floorId, batchId) =>
      Promise.resolve(
        floorId === "web-shop" && batchId === 3 ? batchReport : undefined,
      ),
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
    advance(ms) {
      clock.time = new Date(clock.time.getTime() + ms);
    },
    at(at) {
      clock.time = at;
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
    addCalendar(name, extra = {}, calendar = calendarId) {
      return agent.add({
        type: "google_calendar",
        name,
        // By the calendar's address, as the Owner copies it from its settings.
        credentials: {
          calendarId: `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calendar)}&ctz=Europe%2FLondon`,
        },
        ...extra,
      });
    },
  };
}

/** The writes (anything but a GET) the fake Calendar was sent. */
const writes = (google: FakeGoogle) =>
  google.calendarRequests.filter(({ method }) => method !== "GET");

const decode = (html: string): string =>
  html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

/** What an event's description says, line by line, and its links. */
const descriptionOf = (event: FakeCalendarEvent | undefined) => {
  const html = event?.description ?? "";
  return {
    lines: decode(
      html
        .replaceAll("<br>", "\n")
        .replaceAll("<li>", "\n- ")
        .replaceAll(/<[^>]*>/g, ""),
    )
      .split("\n")
      .filter((line) => line !== ""),
    links: [...html.matchAll(/<a href="([^"]*)">(.*?)<\/a>/g)].map(
      ([, url = "", text = ""]) => ({ text: decode(text), url: decode(url) }),
    ),
  };
};

describe("Google sign-in for Calendar", () => {
  it("asks for calendar.events and nothing else; beside Docs, Drive's too", async () => {
    const setup = await setUp();
    await setup.addCalendar("Batches");
    expect((await setup.auth.info()).services).toEqual(["calendar"]);
    expect((await setup.auth.info()).scopes).toEqual([calendarScope]);
    await setup.signIn();
    expect(setup.google.consents.at(-1)?.scopes).toEqual([calendarScope]);

    await setup.agent.add({
      type: "google_docs",
      name: "Docs",
      credentials: { folderId: docsFolder },
    });
    expect((await setup.auth.info()).scopes).toEqual([
      calendarScope,
      driveScope,
    ]);
    expect((await setup.auth.info()).missingServices).toEqual(["docs"]);
  });

  it("a sign-in that did not allow Calendar says so, and calls no Calendar API", async () => {
    const setup = await setUp();
    const calendar = await setup.addCalendar("Batches");
    await setup.agent.add({
      type: "google_docs",
      name: "Docs",
      credentials: { folderId: docsFolder },
    });
    // The Owner unticks Calendar on the consent screen.
    await setup.signIn([driveScope]);
    expect((await setup.auth.info()).missingServices).toEqual(["calendar"]);
    expect((await setup.agent.sendTest(calendar.id)).error).toBe(
      "The Google sign-in does not allow Google Calendar: sign in to Google again to allow it.",
    );
    expect(setup.google.calendarRequests).toEqual([]);
  });
});

describe("a Batch's event", () => {
  it("is made on the calendar when the Batch starts, and changed to its finish when it finishes, with its Plan and outcome", async () => {
    const setup = await setUp();
    const { id } = await setup.addCalendar("Batches");
    await setup.signIn();
    const eventId = calendarEventId(id, { floorId: "web-shop", batchId: 3 });

    // Started: one event, an hour long until it finishes.
    await setup.bus.publish(started());
    await setup.run();
    expect(await setup.agent.deliveries(id)).toMatchObject([
      { status: "delivered", attempts: 1 },
    ]);
    let [event, ...more] = setup.google.calendarEvents(calendarId);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      id: eventId,
      status: "confirmed",
      summary: "AI Office: Batch 3 (Web shop), in progress",
      start: startedAt.toISOString(),
      end: new Date(startedAt.getTime() + hour).toISOString(),
      source: { title: "The Plan in AI Office", url: planUrl },
      transparency: "transparent",
      sequence: 0,
    });
    expect(descriptionOf(event)).toEqual({
      lines: [
        "Batch 3 on Web shop is in progress: work started on #1.",
        "Open the Plan in AI Office",
      ],
      links: [{ text: "Open the Plan in AI Office", url: planUrl }],
    });
    // Looked for, then made with AI Office's own id.
    expect(setup.google.calendarRequests).toEqual([
      {
        method: "GET",
        path: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      },
      {
        method: "POST",
        path: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      },
    ]);

    // Finished: the same event, from its start to its finish, with its outcome.
    setup.at(finishedAt);
    await setup.bus.publish(finished());
    await setup.run();
    [event, ...more] = setup.google.calendarEvents(calendarId);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      id: eventId,
      status: "confirmed",
      summary:
        "AI Office: Batch 3 (Web shop): 1 of 3 issues merged, 1 blocked, 1 not started",
      start: startedAt.toISOString(),
      end: finishedAt.toISOString(),
      source: { title: "The Plan in AI Office", url: planUrl },
      transparency: "transparent",
      sequence: 1,
    });
    const description = descriptionOf(event);
    expect(description.lines).toEqual([
      "Batch 3 on Web shop finished: 1 of 3 issues merged, 1 blocked, 1 not started. 240,000 tokens, about $2.40 (estimated).",
      "- #1 Add a basket: Merged, PR #11",
      '- #2 Show the total <a href="https://evil.example">click</a> **now** [here](https://evil.example) [REDACTED]: Blocked, PR #12',
      "- #4 Pay at checkout: Not started",
      "Open the Plan in AI Office",
    ]);
    // What the title says is only text: its links are AI Office's own.
    expect(description.links).toEqual([
      { text: "#1", url: issueUrl(1) },
      { text: "PR #11", url: pull(11) },
      { text: "#2", url: issueUrl(2) },
      { text: "PR #12", url: pull(12) },
      { text: "#4", url: issueUrl(4) },
      { text: "Open the Plan in AI Office", url: planUrl },
    ]);
    expect(event?.description).not.toContain("sk-ant-");
    expect(writes(setup.google).map(({ method }) => method)).toEqual([
      "POST",
      "PATCH",
    ]);
    expect(await setup.agent.deliveries(id)).toMatchObject([
      {
        status: "delivered",
        message: { kind: "batch_finished" },
      },
      {
        status: "delivered",
        message: { kind: "batch_started" },
      },
    ]);

    // Another Batch is another event.
    await setup.bus.publish(started(4));
    await setup.run();
    expect(
      setup.google.calendarEvents(calendarId).map(({ summary }) => summary),
    ).toEqual([
      "AI Office: Batch 3 (Web shop): 1 of 3 issues merged, 1 blocked, 1 not started",
      "AI Office: Batch 4 (Web shop), in progress",
    ]);
  });

  it("is never made twice when an answer is lost and the delivery tried again", async () => {
    const setup = await setUp();
    const { id } = await setup.addCalendar("Batches");
    await setup.signIn();

    // The start's answer is lost: the event is made, the delivery fails.
    setup.google.loseNextAnswer();
    await setup.bus.publish(started());
    await setup.run();
    expect(setup.google.calendarEvents(calendarId)).toHaveLength(1);
    const [first] = await setup.agent.deliveries(id);
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    expect(first?.error).toBe("Google Calendar answered 502: Bad gateway.");
    // Tried again, it finds the event by its id and leaves it.
    setup.advance(5000);
    await setup.agent.deliverDue();
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
    });
    expect(setup.google.calendarEvents(calendarId)).toMatchObject([
      { summary: "AI Office: Batch 3 (Web shop), in progress", sequence: 0 },
    ]);

    // The finish's answer is lost too: changing it again changes the one event.
    setup.at(finishedAt);
    setup.google.loseNextAnswer();
    await setup.bus.publish(finished());
    await setup.run();
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    setup.advance(5000);
    await setup.agent.deliverDue();
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
    });
    expect(setup.google.calendarEvents(calendarId)).toMatchObject([
      {
        summary:
          "AI Office: Batch 3 (Web shop): 1 of 3 issues merged, 1 blocked, 1 not started",
        start: startedAt.toISOString(),
        end: finishedAt.toISOString(),
      },
    ]);
    // One make, and the finish's change twice.
    expect(writes(setup.google).map(({ method }) => method)).toEqual([
      "POST",
      "PATCH",
      "PATCH",
    ]);
  });

  it("is made whole by the finish when the start has not arrived, and the start then leaves it as it is", async () => {
    const setup = await setUp();
    const { id } = await setup.addCalendar("Batches");
    await setup.signIn();

    // The start is rate-limited for ten minutes.
    setup.google.rateLimit(1, 600);
    await setup.bus.publish(started());
    await setup.run();
    expect((await setup.agent.deliveries(id))[0]?.error).toBe(
      "Google Calendar is rate-limiting this Connection (429).",
    );
    expect(setup.google.calendarEvents(calendarId)).toEqual([]);

    // The Batch finishes first: its event is made from start to finish, and
    // the make's answer is lost.
    setup.advance(60_000);
    setup.google.loseNextAnswer();
    await setup.bus.publish(finished());
    await setup.run();
    setup.advance(5000);
    await setup.agent.deliverDue();
    const finishedEvent = {
      summary:
        "AI Office: Batch 3 (Web shop): 1 of 3 issues merged, 1 blocked, 1 not started",
      start: startedAt.toISOString(),
      end: finishedAt.toISOString(),
    };
    expect(setup.google.calendarEvents(calendarId)).toMatchObject([
      finishedEvent,
    ]);

    // Then the start: the event is there, and stays finished.
    setup.advance(600_000);
    await setup.agent.deliverDue();
    expect(
      (await setup.agent.deliveries(id)).map(({ status }) => status),
    ).toEqual(["delivered", "delivered"]);
    expect(setup.google.calendarEvents(calendarId)).toMatchObject([
      finishedEvent,
    ]);
    // Not there to change; made (its answer lost); changed on the retry.
    expect(writes(setup.google).map(({ method }) => method)).toEqual([
      "PATCH",
      "POST",
      "PATCH",
    ]);
  });

  it("is made by the finish for a Connection added during the Batch, and one event per Connection", async () => {
    const setup = await setUp();
    const first = await setup.addCalendar("Batches");
    await setup.signIn();
    await setup.bus.publish(started());
    await setup.run();
    // Added after the Batch started: it is not sent the start.
    setup.advance(60_000);
    const second = await setup.addCalendar("Team calendar");
    const elsewhere = await setup.addCalendar(
      "Other calendar",
      {},
      otherCalendarId,
    );
    expect(await setup.agent.deliveries(second.id)).toEqual([]);

    setup.at(finishedAt);
    await setup.bus.publish(finished());
    await setup.run();
    // Two Connections on one calendar: each its own event, by its own id.
    const events = setup.google.calendarEvents(calendarId);
    expect(events.map(({ id }) => id)).toEqual([
      calendarEventId(first.id, { floorId: "web-shop", batchId: 3 }),
      calendarEventId(second.id, { floorId: "web-shop", batchId: 3 }),
    ]);
    for (const event of [
      ...events,
      ...setup.google.calendarEvents(otherCalendarId),
    ]) {
      expect(event).toMatchObject({
        start: startedAt.toISOString(),
        end: finishedAt.toISOString(),
      });
    }
    expect(setup.google.calendarEvents(otherCalendarId)).toHaveLength(1);
    expect(await setup.agent.deliveries(elsewhere.id)).toHaveLength(1);
  });

  it("the Owner deleted stays deleted, and is not made again", async () => {
    const setup = await setUp();
    const { id } = await setup.addCalendar("Batches");
    await setup.signIn();
    const eventId = calendarEventId(id, { floorId: "web-shop", batchId: 3 });
    await setup.bus.publish(started());
    await setup.run();

    // Deleted in Calendar: the finish changes it, and it stays deleted.
    setup.google.deleteEvent(calendarId, eventId);
    setup.at(finishedAt);
    await setup.bus.publish(finished());
    await setup.run();
    expect(setup.google.calendarEvents(calendarId)).toMatchObject([
      { id: eventId, status: "cancelled" },
    ]);

    // Another Batch's event deleted and purged before it finishes: its id
    // is taken, so nothing is made.
    await setup.bus.publish(started(5));
    await setup.run();
    const purged = calendarEventId(id, { floorId: "web-shop", batchId: 5 });
    setup.google.deleteEvent(calendarId, purged, { purge: true });
    await setup.bus.publish(finished(5));
    await setup.run();
    expect(setup.google.calendarEvents(calendarId)).toMatchObject([
      { id: eventId, status: "cancelled" },
    ]);
    expect(
      (await setup.agent.deliveries(id)).map(({ status }) => status),
    ).toEqual(["delivered", "delivered", "delivered", "delivered"]);
  });
});

describe("detail levels, Floors and what is sent", () => {
  it('"links only": counts and links; no Floor name or issue title', async () => {
    const setup = await setUp();
    await setup.addCalendar("Batches", { detailLevel: "links_only" });
    await setup.signIn();
    await setup.bus.publish(started());
    await setup.run();
    expect(setup.google.calendarEvents(calendarId)[0]).toMatchObject({
      summary: "AI Office: Batch 3, in progress",
    });
    expect(descriptionOf(setup.google.calendarEvents(calendarId)[0])).toEqual({
      lines: [
        "Batch 3 is in progress: work started on #1.",
        "Open the Plan in AI Office",
      ],
      links: [{ text: "Open the Plan in AI Office", url: planUrl }],
    });

    setup.at(finishedAt);
    await setup.bus.publish(finished());
    await setup.run();
    const [event] = setup.google.calendarEvents(calendarId);
    expect(event?.summary).toBe(
      "AI Office: Batch 3: 1 of 3 issues merged, 1 blocked, 1 not started",
    );
    const description = descriptionOf(event);
    expect(description.lines).toEqual([
      "Batch 3 finished: 1 of 3 issues merged, 1 blocked, 1 not started. 240,000 tokens, about $2.40 (estimated).",
      "- #1: Merged, PR #11",
      "- #2: Blocked, PR #12",
      "- #4: Not started",
      "Open the Plan in AI Office",
    ]);
    expect(description.links.map(({ url }) => url)).toEqual([
      issueUrl(1),
      pull(11),
      issueUrl(2),
      pull(12),
      issueUrl(4),
      planUrl,
    ]);
    for (const absent of ["Web shop", "Add a basket", "Show the total"]) {
      expect(
        `${event?.summary ?? ""}\n${event?.description ?? ""}`,
      ).not.toContain(absent);
    }
  });

  it("only its Floors' Batches; never a Notice or a merge; without a Wrap-up, the finish from the event", async () => {
    const setup = await setUp();
    const { id } = await setup.addCalendar("Web shop only", {
      rules: {
        actionNotices: true,
        infoNotices: true,
        workComplete: true,
        floorIds: ["web-shop"],
        changelog: true,
      },
    });
    const all = await setup.addCalendar("Every Floor", {}, otherCalendarId);
    // A calendar keeps its Floors only.
    expect((await setup.agent.get(id)).rules).toEqual({
      actionNotices: false,
      infoNotices: false,
      workComplete: false,
      floorIds: ["web-shop"],
      changelog: false,
    });
    await setup.signIn();
    await setup.bus.publish({
      type: "notice.raised",
      version: 1,
      noticeId: "notice-9",
      kind: "action",
      title: "PR #11 awaiting your approval",
      floorId: "web-shop",
    });
    await setup.bus.publish({
      type: "pull_request.merged",
      version: 1,
      floorId: "web-shop",
      issue: 1,
      pullRequest: 11,
      url: pull(11),
      sha: "b".repeat(40),
      by: "app",
    });
    await setup.run();
    expect(await setup.agent.deliveries(id)).toEqual([]);
    expect(await setup.agent.deliveries(all.id)).toEqual([]);

    // Batch 7 on another Floor, whose Wrap-up AI Office no longer has.
    await setup.bus.publish(started(7, "docs-site"));
    setup.at(finishedAt);
    await setup.bus.publish(finished(7, "docs-site"));
    await setup.run();
    expect(await setup.agent.deliveries(id)).toEqual([]);
    expect(setup.google.calendarEvents(calendarId)).toEqual([]);
    const [event] = setup.google.calendarEvents(otherCalendarId);
    expect(event).toMatchObject({
      summary:
        "AI Office: Batch 7 (docs-site): 1 of 3 issues merged, 1 blocked, 1 not started",
      start: startedAt.toISOString(),
      end: finishedAt.toISOString(),
    });
    expect(descriptionOf(event).lines).toEqual([
      "Batch 7 on docs-site finished: 1 of 3 issues merged, 1 blocked, 1 not started. 240,000 tokens.",
      "Open the Plan in AI Office",
    ]);
  });
});

describe("Send test and failures", () => {
  it("Send test only reads the calendar, and says when it cannot be found", async () => {
    const setup = await setUp();
    const calendar = await setup.addCalendar("Batches");
    expect(calendar.details).toEqual([`On calendar ${calendarId}`]);
    expect(calendar.hint).toBe("Calendar c_0123456789…");
    await setup.signIn();
    expect(await setup.agent.sendTest(calendar.id)).toMatchObject({
      delivered: true,
      error: null,
    });
    expect(setup.google.calendarRequests).toEqual([
      {
        method: "GET",
        path: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      },
    ]);
    const missing = await setup.agent.add({
      type: "google_calendar",
      name: "Missing",
      credentials: { calendarId: "nobody@group.calendar.google.com" },
    });
    expect((await setup.agent.sendTest(missing.id)).error).toBe(
      "Google Calendar cannot find the calendar or an event on it: check its id, and share it with the Google account signed in (404).",
    );
    expect(writes(setup.google)).toEqual([]);
  });

  it("takes a calendar's id, its address or primary, and refuses anything else", async () => {
    const setup = await setUp();
    const ical = await setup.agent.add({
      type: "google_calendar",
      name: "By its iCal address",
      credentials: {
        calendarId: `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/private-0123/basic.ics`,
      },
    });
    expect(ical.details).toEqual([`On calendar ${calendarId}`]);
    const primary = await setup.agent.add({
      type: "google_calendar",
      name: "Mine",
      credentials: { calendarId: " primary " },
    });
    expect(primary.hint).toBe("Primary calendar");
    await expect(
      setup.agent.add({
        type: "google_calendar",
        name: "Not a calendar",
        credentials: { calendarId: "https://example.com/my-calendar" },
      }),
    ).rejects.toThrow("Give the calendar's id");
  });
});
