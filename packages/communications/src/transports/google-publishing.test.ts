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
import type { BatchReport, ReportRequest, ReportWriter } from "../report.ts";
import { memoryCommunicationsStore } from "../store.ts";
import { readPdf, serveFakeGoogle, type FakeGoogle } from "../testing.ts";
import { defaultTransports } from "./defaults.ts";
import { googleDocsTransport } from "./google-docs.ts";
import { googleDriveTransport } from "./google-drive.ts";
import { googleSlidesTransport } from "./google-slides.ts";

// The Google Docs, Slides and Drive Connections' contract (PRD FR-91,
// FR-92, FR-94, FR-95), against a fake Google whose Drive, Docs and Slides
// APIs answer as Google's do: a finished Batch makes exactly one document,
// one deck, and one Markdown and one PDF file in the Connection's folder,
// even when an answer is lost and the delivery tried again; with a running
// changelog (Google Docs), each merged pull request is one entry in one
// changelog document; each artefact is at its Connection's detail level,
// redacted, and what the report quotes is only ever text; signing in asks
// for Drive's scope and no more; and "Send test" only reads the folder.

const start = new Date("2026-10-10T11:00:00.000Z");
const publicUrl = "https://office.example.com";
const clientId = "1234567890-abcdefghijklmnop.apps.googleusercontent.com";
const clientSecret = "GOCSPX-fakeClientSecret0123456789ab";
const docsFolder = "1DocsFolder_AbCdEfGhIjKlMnOpQrStUv";
const slidesFolder = "1SlidesFolder_AbCdEfGhIjKlMnOpQrSt";
const driveFolder = "1DriveFolder_AbCdEfGhIjKlMnOpQrStU";
const spreadsheetId = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";
const driveScope = "https://www.googleapis.com/auth/drive";
const sheetsScope = "https://www.googleapis.com/auth/spreadsheets";
const anthropicKey = "sk-ant-api03-pastedintoanissue-Qw3Er4Ty5Ui6Op7As8Df9";
const pull = (number: number) =>
  `https://github.com/adrianeyre/web-shop/pull/${String(number)}`;
const issueUrl = (number: number) =>
  `https://github.com/adrianeyre/web-shop/issues/${String(number)}`;
const wrapUpUrl = `${publicUrl}/floors/web-shop/whiteboard?batch=3`;
const title = "AI Office: Batch 3 Wrap-up (Web shop)";

/** Batch 3 on web-shop, as AI Office keeps its Wrap-up. */
const batchReport: BatchReport = {
  batchId: 3,
  floor: {
    id: "web-shop",
    name: "Web shop",
    repository: "adrianeyre/web-shop",
  },
  startedAt: new Date("2026-10-10T09:00:00.000Z"),
  finishedAt: new Date("2026-10-10T10:50:00.000Z"),
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
      // A title is untrusted text: a planted key, and Markdown that would
      // add a link and break the table.
      issue: 2,
      title: `Show the total | **now** [click](https://evil.example) ${anthropicKey}`,
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
  leftOut: [{ issue: 6, reason: "it is closed" }],
  totals: {
    merged: 1,
    closed: 0,
    blocked: 1,
    notStarted: 1,
    tokens: 240_000,
    estimatedCostUsd: 2.4,
  },
};

const finished: OfficeEvent = {
  type: "batch.finished",
  version: 1,
  floorId: "web-shop",
  batchId: 3,
  agentId: "grace",
  agentIds: ["ada", "alan"],
  issues: [1, 2, 4],
  merged: 1,
  closed: 0,
  blocked: 1,
  notStarted: 1,
  tokens: 240_000,
};

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

/** The summary the Communications Agent's Model writes. */
const modelSummary = `One issue merged and one waits for the Owner. [Open](https://evil.example) ${anthropicKey}`;

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Setup {
  readonly google: FakeGoogle;
  readonly auth: GoogleAuth;
  readonly bus: EventBus;
  readonly agent: Communications;
  /** What the Model was asked to write. */
  readonly asked: ReportRequest[];
  readonly advance: (ms: number) => void;
  /** Takes every event in, and sends what is due. */
  readonly run: () => Promise<void>;
  /** Plays the Owner through the consent screen, approving it (or `grant` only). */
  readonly signIn: (grant?: readonly string[]) => Promise<void>;
}

async function setUp(): Promise<Setup> {
  const clock = { time: start };
  const now = () => clock.time;
  const google = await serveFakeGoogle({
    clientId,
    clientSecret,
    redirectUri: `${publicUrl}${googleRedirectPath}`,
    spreadsheets: [{ id: spreadsheetId, tabs: ["Sheet1"] }],
    folders: [
      { id: docsFolder, name: "Wrap-up documents" },
      { id: slidesFolder, name: "Wrap-up decks" },
      { id: driveFolder, name: "Wrap-up files" },
    ],
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
  const asked: ReportRequest[] = [];
  const reportWriter: ReportWriter = {
    write(request) {
      asked.push(structuredClone(request));
      return Promise.resolve(modelSummary);
    },
  };
  const apis = { google: auth, ...google.apiUrls, timeoutMs: 2000 };
  const agent = createCommunications({
    store,
    events: bus,
    encryptor,
    transports: {
      ...defaultTransports({ google: auth }),
      google_docs: googleDocsTransport(apis),
      google_slides: googleSlidesTransport(apis),
      google_drive: googleDriveTransport(apis),
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
    issueTitle: (floorId, issue) =>
      Promise.resolve(
        floorId === "web-shop"
          ? { 1: "Add a basket", 2: `Show the total ${anthropicKey}` }[issue]
          : undefined,
      ),
    reportWriter,
    defaultModels: () => Promise.resolve({ Claude: "claude-haiku-5-5" }),
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
    asked,
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
  };
}

type GoogleFolderType = "google_docs" | "google_slides" | "google_drive";

const folderRequest = (
  type: GoogleFolderType,
  name: string,
  folder: string,
  extra: Record<string, unknown> = {},
) =>
  ({
    type,
    name,
    // By the folder's address, as the Owner copies it from Drive.
    credentials: {
      folderId: `https://drive.google.com/drive/folders/${folder}?usp=sharing`,
    },
    ...extra,
  }) as Parameters<Communications["add"]>[0];

/** The writes (anything but a GET) the fake was sent, as method and path. */
const writes = (google: FakeGoogle) =>
  google.workspaceRequests.filter(({ method }) => method !== "GET");

/** Everything a document says, and every link in it. */
const documentOf = (google: FakeGoogle, documentId: string) => {
  const paragraphs = google.document(documentId) ?? [];
  return {
    paragraphs,
    text: paragraphs.map((paragraph) => paragraph.text).join("\n"),
    links: paragraphs.flatMap((paragraph) =>
      paragraph.runs.flatMap((run) =>
        run.link === undefined ? [] : [{ text: run.text, url: run.link }],
      ),
    ),
  };
};

/** Everything a deck says, and every link in it. */
const deckOf = (google: FakeGoogle, presentationId: string) => {
  const slides = google.presentation(presentationId) ?? [];
  const texts = slides.flatMap((slide) => slide.texts);
  return {
    slides,
    text: texts.map((one) => one.text).join("\n"),
    links: texts.flatMap((one) => one.links),
  };
};

/** Everything a PDF says, and every link in it. */
const pdfOf = (bytes: Buffer | undefined) => {
  const pdf = readPdf(bytes ?? Buffer.alloc(0));
  return {
    pdf,
    text: pdf.pages.flatMap((page) => page.lines).join("\n"),
    links: pdf.pages.flatMap((page) => page.links.map(({ url }) => url)),
  };
};

describe("Google sign-in for Docs, Slides and Drive", () => {
  it("asks for Drive's scope and nothing else; beside a work log, Sheets' too", async () => {
    const setup = await setUp();
    await setup.agent.add(folderRequest("google_docs", "Docs", docsFolder));
    await setup.agent.add(
      folderRequest("google_slides", "Slides", slidesFolder),
    );
    await setup.agent.add(folderRequest("google_drive", "Drive", driveFolder));
    const info = await setup.auth.info();
    expect(info.services).toEqual(["docs", "slides", "drive"]);
    expect(info.scopes).toEqual([driveScope]);
    await setup.signIn();
    expect(setup.google.consents.at(-1)?.scopes).toEqual([driveScope]);

    await setup.agent.add({
      type: "google_sheets",
      name: "Work log",
      credentials: { spreadsheetId, tab: "Work log" },
    });
    expect((await setup.auth.info()).scopes).toEqual([driveScope, sheetsScope]);
    // Signed in before, for Drive only: Sheets is missing until it asks again.
    expect((await setup.auth.info()).missingServices).toEqual(["sheets"]);
  });

  it("a sign-in that did not allow Drive says so, for each of them", async () => {
    const setup = await setUp();
    const docs = await setup.agent.add(
      folderRequest("google_docs", "Docs", docsFolder),
    );
    await setup.agent.add({
      type: "google_sheets",
      name: "Work log",
      credentials: { spreadsheetId, tab: "Work log" },
    });
    // The Owner unticks Drive on the consent screen.
    await setup.signIn([sheetsScope]);
    expect((await setup.auth.info()).missingServices).toEqual(["docs"]);
    expect((await setup.agent.sendTest(docs.id)).error).toBe(
      "The Google sign-in does not allow Google Docs: sign in to Google again to allow it.",
    );
    expect(setup.google.workspaceRequests).toEqual([]);
  });
});

describe("Google Docs", () => {
  it("a finished Batch makes exactly one document in the folder with its Wrap-up report, even when the answer is lost and it is sent again", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add(
      folderRequest("google_docs", "Wrap-up docs", docsFolder),
    );
    await setup.signIn();
    // Its upload's answer is lost: the document is made, the delivery fails.
    setup.google.loseNextAnswer();
    await setup.bus.publish(finished);
    await setup.run();
    expect(setup.google.files(docsFolder)).toHaveLength(1);
    const [first] = await setup.agent.deliveries(id);
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    expect(first?.error).toBe("Google Drive answered 502: Bad gateway.");

    // Tried again, it finds the document by its delivery's id: no other.
    setup.advance(5000);
    await setup.agent.deliverDue();
    const [delivery] = await setup.agent.deliveries(id);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 2 });
    const files = setup.google.files(docsFolder);
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toMatchObject({
      name: title,
      mimeType: "application/vnd.google-apps.document",
      appProperties: { aiOfficeDelivery: delivery?.id },
    });
    expect(writes(setup.google)).toEqual([
      { method: "POST", path: "/upload/drive/v3/files" },
    ]);

    // The report, converted: headings, the Plan, the Results, the links.
    const document = documentOf(setup.google, file?.id ?? "");
    expect(document.paragraphs.map(({ style, text }) => [style, text])).toEqual(
      [
        ["HEADING_1", title],
        [
          "NORMAL_TEXT",
          "Finished 10 Oct 2026, 10:50 UTC, on version 2 of the Plan: 1 of 3 issues merged, 1 blocked, 1 not started. 240,000 tokens, about $2.40 (estimated).",
        ],
        ["HEADING_2", "Summary"],
        [
          "NORMAL_TEXT",
          "One issue merged and one waits for the Owner. [Open](https://evil.example) [REDACTED]",
        ],
        ["HEADING_2", "The Plan"],
        ["NORMAL_TEXT", "#1 Add a basket: Ada"],
        [
          "NORMAL_TEXT",
          "#2 Show the total | **now** [click](https://evil.example) [REDACTED]: Alan, after #1",
        ],
        ["NORMAL_TEXT", "#4 Pay at checkout, after #2"],
        ["NORMAL_TEXT", "In parallel: #1; then #2; then #4."],
        ["HEADING_2", "Results"],
        [
          "NORMAL_TEXT",
          "Issue\tOutcome\tPull request\tRounds (review, QA)\tTokens\tEstimated cost",
        ],
        [
          "NORMAL_TEXT",
          "#1 Add a basket\tMerged\tPR #11\t2, 1\t150,000\t$1.50",
        ],
        [
          "NORMAL_TEXT",
          "#2 Show the total | **now** [click](https://evil.example) [REDACTED]\tBlocked\tPR #12\t3, 0\t90,000\t$0.90",
        ],
        [
          "NORMAL_TEXT",
          "#4 Pay at checkout\tNot started\tNone\t0, 0\t0\t$0.00",
        ],
        [
          "NORMAL_TEXT",
          "Total\t1 of 3 issues merged, 1 blocked, 1 not started\t\t\t240,000\t$2.40",
        ],
        ["HEADING_2", "Left out"],
        ["NORMAL_TEXT", "#6: it is closed"],
        ["NORMAL_TEXT", "Open the Wrap-up in AI Office"],
      ],
    );
    expect(document.links).toEqual([
      { text: "#1", url: issueUrl(1) },
      { text: "#2", url: issueUrl(2) },
      { text: "#4", url: issueUrl(4) },
      { text: "#1", url: issueUrl(1) },
      { text: "PR #11", url: pull(11) },
      { text: "#2", url: issueUrl(2) },
      { text: "PR #12", url: pull(12) },
      { text: "#4", url: issueUrl(4) },
      { text: "#6", url: issueUrl(6) },
      { text: "Open the Wrap-up in AI Office", url: wrapUpUrl },
    ]);
  });

  it("the changelog: one document in the folder, made with the first entry, and each merged pull request appended once, a lost answer included", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add(
      folderRequest("google_docs", "Changelog", docsFolder, {
        rules: {
          actionNotices: true,
          infoNotices: true,
          workComplete: true,
          floorIds: ["web-shop"],
          changelog: true,
        },
      }),
    );
    // Without a changelog, merges publish nothing.
    const reportsOnly = await setup.agent.add(
      folderRequest("google_docs", "Reports only", slidesFolder),
    );
    await setup.signIn();
    await setup.bus.publish(merged(11, 1));
    await setup.bus.publish(merged(12, 2));
    // Outside its Floors.
    await setup.bus.publish(merged(31, 30, "blog"));
    await setup.run();
    // The third entry's answer is lost: written, then tried again.
    setup.google.loseNextAnswer();
    await setup.bus.publish(merged(15, 4));
    await setup.run();
    const third = (await setup.agent.deliveries(id)).find(
      ({ message }) => message.githubUrl === pull(15),
    );
    expect(third).toMatchObject({
      status: "pending",
      error: "Google Docs answered 502: Bad gateway.",
    });
    setup.advance(5000);
    await setup.agent.deliverDue();

    const deliveries = await setup.agent.deliveries(id);
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every(({ status }) => status === "delivered")).toBe(true);
    expect(await setup.agent.deliveries(reportsOnly.id)).toEqual([]);
    const files = setup.google.files(docsFolder);
    expect(
      files.map(({ name, appProperties }) => [name, appProperties]),
    ).toEqual([["AI Office changelog", { aiOfficeChangelog: "1" }]]);
    const document = documentOf(setup.google, files[0]?.id ?? "");
    expect(document.paragraphs.map(({ text }) => text)).toEqual([
      "AI Office changelog",
      "Each pull request AI Office merges, newest last.",
      "2026-10-10 · Web shop · Pull request #11 merged, closing issue #1: Add a basket",
      "2026-10-10 · Web shop · Pull request #12 merged, closing issue #2: Show the total [REDACTED]",
      "2026-10-10 · Web shop · Pull request #15 merged, closing issue #4",
    ]);
    // Each entry's date bold and its title a link; nothing taken on from
    // the entry before.
    for (const [index, number] of [11, 12, 15].entries()) {
      const runs = document.paragraphs[index + 2]?.runs ?? [];
      expect(runs.map(({ text, bold, link }) => [text, bold, link])).toEqual([
        ["2026-10-10", true, undefined],
        [" · Web shop · ", false, undefined],
        [runs[2]?.text, false, pull(number)],
      ]);
    }
    // A batch update per entry: the lost one's retry found its entry.
    expect(
      writes(setup.google).filter(({ path }) => path.endsWith(":batchUpdate")),
    ).toHaveLength(3);
  });
});

describe("Google Slides", () => {
  it("a finished Batch makes exactly one deck in the folder, its slides written once, even when answers are lost", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add(
      folderRequest("google_slides", "Decks", slidesFolder),
    );
    await setup.signIn();
    // The deck's answer is lost: it is made, the delivery fails.
    setup.google.loseNextAnswer();
    await setup.bus.publish(finished);
    await setup.run();
    expect(setup.google.files(slidesFolder)).toHaveLength(1);
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Google Drive answered 502: Bad gateway.",
    });
    // Then the slides' answer is lost: written, the delivery fails again.
    setup.google.loseNextAnswer();
    setup.advance(5000);
    await setup.agent.deliverDue();
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "pending",
      attempts: 2,
      error: "Google Slides answered 502: Bad gateway.",
    });
    // The third attempt finds the deck and its slides, and writes nothing.
    setup.advance(10_000);
    await setup.agent.deliverDue();
    const [delivery] = await setup.agent.deliveries(id);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 3 });
    const files = setup.google.files(slidesFolder);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: title,
      mimeType: "application/vnd.google-apps.presentation",
      appProperties: { aiOfficeDelivery: delivery?.id },
    });
    expect(writes(setup.google)).toEqual([
      { method: "POST", path: "/drive/v3/files" },
      {
        method: "POST",
        path: `/v1/presentations/${files[0]?.id ?? ""}:batchUpdate`,
      },
    ]);

    // Title, outcomes, issues and pull requests, tokens and cost; the
    // slide it was made with is gone.
    const deck = deckOf(setup.google, files[0]?.id ?? "");
    expect(
      deck.slides.map(({ objectId, layout, texts }) => [
        objectId,
        layout,
        texts.map(({ placeholder, text }) => [placeholder, text]),
      ]),
    ).toEqual([
      [
        "aio_s0",
        "TITLE",
        [
          ["CENTERED_TITLE", title],
          [
            "SUBTITLE",
            "Finished 10 Oct 2026, 10:50 UTC, on version 2 of the Plan: 1 of 3 issues merged, 1 blocked, 1 not started. 240,000 tokens, about $2.40 (estimated).\nOpen the Wrap-up in AI Office",
          ],
        ],
      ],
      [
        "aio_s1",
        "TITLE_AND_BODY",
        [
          ["TITLE", "Outcomes"],
          [
            "BODY",
            "One issue merged and one waits for the Owner. [Open](https://evil.example) [REDACTED]",
          ],
        ],
      ],
      [
        "aio_s2",
        "TITLE_AND_BODY",
        [
          ["TITLE", "Issues and pull requests"],
          [
            "BODY",
            [
              "#1 Add a basket · Merged · PR #11",
              "#2 Show the total | **now** [click](https://evil.example) [REDACTED] · Blocked · PR #12",
              "#4 Pay at checkout · Not started · None",
            ].join("\n"),
          ],
        ],
      ],
      [
        "aio_s3",
        "TITLE_AND_BODY",
        [
          ["TITLE", "Tokens and cost"],
          [
            "BODY",
            [
              "Total: 240,000 tokens, about $2.40 (estimated)",
              "#1 Add a basket: 150,000 tokens, $1.50; rounds (review, QA) 2, 1",
              "#2 Show the total | **now** [click](https://evil.example) [REDACTED]: 90,000 tokens, $0.90; rounds (review, QA) 3, 0",
              "#4 Pay at checkout: 0 tokens, $0.00; rounds (review, QA) 0, 0",
            ].join("\n"),
          ],
        ],
      ],
    ]);
    expect(deck.links).toEqual([
      { text: "Open the Wrap-up in AI Office", url: wrapUpUrl },
      { text: "#1", url: issueUrl(1) },
      { text: "PR #11", url: pull(11) },
      { text: "#2", url: issueUrl(2) },
      { text: "PR #12", url: pull(12) },
      { text: "#4", url: issueUrl(4) },
      { text: "#1", url: issueUrl(1) },
      { text: "#2", url: issueUrl(2) },
      { text: "#4", url: issueUrl(4) },
    ]);
    expect(deck.slides[3]?.texts[1]?.bold).toEqual([
      "Total: 240,000 tokens, about $2.40 (estimated)",
    ]);
  });
});

describe("Google Drive", () => {
  it("a finished Batch saves exactly one Markdown and one PDF file in the folder, even when an answer is lost", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add(
      folderRequest("google_drive", "Files", driveFolder),
    );
    await setup.signIn();
    // The Markdown file's answer is lost: it is saved, the delivery fails.
    setup.google.loseNextAnswer();
    await setup.bus.publish(finished);
    await setup.run();
    expect(setup.google.files(driveFolder)).toHaveLength(1);
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    // Tried again, it saves only the PDF.
    setup.advance(5000);
    await setup.agent.deliverDue();
    const [delivery] = await setup.agent.deliveries(id);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 2 });
    const files = setup.google.files(driveFolder);
    expect(
      files.map(({ name, mimeType, appProperties }) => [
        name,
        mimeType,
        appProperties,
      ]),
    ).toEqual([
      [`${title}.md`, "text/markdown", { aiOfficeDelivery: delivery?.id }],
      [`${title}.pdf`, "application/pdf", { aiOfficeDelivery: delivery?.id }],
    ]);
    expect(writes(setup.google)).toEqual([
      { method: "POST", path: "/upload/drive/v3/files" },
      { method: "POST", path: "/upload/drive/v3/files" },
    ]);

    // The Markdown is the report, as the other destinations are sent it.
    const markdown = files[0]?.content?.toString("utf8") ?? "";
    expect(markdown).toBe(delivery?.message.document);
    expect(markdown.split("\n").slice(0, 3)).toEqual([
      String.raw`# AI Office: Batch 3 Wrap\-up \(Web shop\)`,
      "",
      "Finished 10 Oct 2026, 10:50 UTC, on version 2 of the Plan: 1 of 3 issues merged, 1 blocked, 1 not started. 240,000 tokens, about $2.40 (estimated).",
    ]);

    // The PDF says the same, its links annotations.
    const { pdf, text, links } = pdfOf(files[1]?.content);
    expect(pdf.title).toBe(title);
    const lines = text.split("\n");
    expect(lines).toContain(title);
    expect(lines).toContain("1. | #1 Add a basket: Ada");
    expect(lines).toContain(
      "#1 Add a basket | Merged | PR #11 | 2, 1 | 150,000 | $1.50",
    );
    expect(lines).toContain("Open the Wrap-up in AI Office");
    expect(links).toEqual([
      issueUrl(1),
      issueUrl(2),
      issueUrl(4),
      issueUrl(1),
      pull(11),
      issueUrl(2),
      pull(12),
      issueUrl(4),
      issueUrl(6),
      wrapUpUrl,
    ]);
  });
});

describe("detail levels and redaction in Docs, Slides and Drive", () => {
  /** Adds one of each at `detailLevel`, publishes the Batch, and reads all four artefacts. */
  const publishAll = async (
    detailLevel: "links_only" | "titles_and_summaries",
  ) => {
    const setup = await setUp();
    for (const [type, folder] of [
      ["google_docs", docsFolder],
      ["google_slides", slidesFolder],
      ["google_drive", driveFolder],
    ] as const) {
      await setup.agent.add(folderRequest(type, type, folder, { detailLevel }));
    }
    await setup.signIn();
    await setup.bus.publish(finished);
    await setup.run();
    const [doc] = setup.google.files(docsFolder);
    const [deck] = setup.google.files(slidesFolder);
    const [markdown, pdf] = setup.google.files(driveFolder);
    const artefacts = [
      { name: "document", ...documentOf(setup.google, doc?.id ?? "") },
      { name: "deck", ...deckOf(setup.google, deck?.id ?? "") },
      {
        name: "Markdown",
        // As a Markdown reader shows it: its escapes undone.
        text: (markdown?.content?.toString("utf8") ?? "").replaceAll(
          /\\(.)/g,
          "$1",
        ),
        links: [],
      },
      { name: "PDF", ...pdfOf(pdf?.content) },
    ];
    return {
      setup,
      names: [doc?.name, deck?.name, markdown?.name, pdf?.name],
      artefacts,
    };
  };

  it('"titles and summaries": titles, the Floor and Agents named, every credential redacted, and what a title or the summary says only ever text', async () => {
    const { setup, names, artefacts } = await publishAll(
      "titles_and_summaries",
    );
    expect(names).toEqual([title, title, `${title}.md`, `${title}.pdf`]);
    // The Model was asked once for all three, from structured data only.
    expect(setup.asked).toHaveLength(1);
    expect(setup.asked[0]?.data.issues.map(({ title: one }) => one)).toEqual([
      "Add a basket",
      "Show the total | **now** [click](https://evil.example) [REDACTED]",
      "Pay at checkout",
    ]);
    for (const { name, text, links } of artefacts) {
      expect(text, name).not.toContain("sk-ant-");
      expect(text, name).toContain("[REDACTED]");
      expect(text, name).toContain("Add a basket");
      expect(text, name).toContain(
        "One issue merged and one waits for the Owner.",
      );
      // A title's or the summary's Markdown is text, never a link.
      const urls = links.map((link) =>
        typeof link === "string" ? link : link.url,
      );
      expect(
        urls.some((url) => url.includes("evil.example")),
        name,
      ).toBe(false);
    }
    // Floor and Agents are named where the report names them.
    for (const { name, text } of artefacts.filter(
      ({ name: one }) => one !== "deck",
    )) {
      expect(text, name).toContain("Web shop");
      expect(text, name).toContain(": Ada");
      expect(text, name).toContain("it is closed");
    }
  });

  it('"links only": kinds, counts and links; no Floor name, issue title, Agent or reason, and no Model call', async () => {
    const { setup, names, artefacts } = await publishAll("links_only");
    const plain = "AI Office: Batch 3 Wrap-up";
    expect(names).toEqual([plain, plain, `${plain}.md`, `${plain}.pdf`]);
    expect(setup.asked).toEqual([]);
    for (const { name, text, links } of artefacts) {
      for (const absent of [
        "Web shop",
        "Add a basket",
        "Show the total",
        "Pay at checkout",
        "Ada",
        "Alan",
        "it is closed",
        "One issue merged",
        "sk-ant-",
      ]) {
        expect(text, `${name}: ${absent}`).not.toContain(absent);
      }
      // Counts and links still.
      expect(text, name).toContain("1 of 3 issues merged");
      const urls = links.map((link) =>
        typeof link === "string" ? link : link.url,
      );
      if (name !== "Markdown") {
        expect(urls, name).toContain(pull(11));
        expect(urls, name).toContain(wrapUpUrl);
      }
    }
  });
});

describe("Send test and failures", () => {
  it("Send test only reads the folder, and says when it is a file or cannot be found", async () => {
    const setup = await setUp();
    const docs = await setup.agent.add(
      folderRequest("google_docs", "Docs", docsFolder),
    );
    const slides = await setup.agent.add(
      folderRequest("google_slides", "Slides", slidesFolder),
    );
    const drive = await setup.agent.add(
      folderRequest("google_drive", "Drive", driveFolder),
    );
    await setup.signIn();
    for (const { id } of [docs, slides, drive]) {
      expect(await setup.agent.sendTest(id)).toMatchObject({
        delivered: true,
        error: null,
      });
    }
    expect(writes(setup.google)).toEqual([]);
    expect(setup.google.workspaceRequests).toEqual([
      { method: "GET", path: `/drive/v3/files/${docsFolder}` },
      { method: "GET", path: `/drive/v3/files/${slidesFolder}` },
      { method: "GET", path: `/drive/v3/files/${driveFolder}` },
    ]);

    // A document's address, not a folder's.
    await setup.bus.publish(finished);
    await setup.run();
    const [document] = setup.google.files(docsFolder);
    const notAFolder = await setup.agent.add({
      type: "google_drive",
      name: "Not a folder",
      credentials: { folderId: document?.id ?? "" },
    });
    expect((await setup.agent.sendTest(notAFolder.id)).error).toBe(
      "That Google Drive address is a file, not a folder: give a folder's.",
    );
    const missing = await setup.agent.add({
      type: "google_slides",
      name: "Missing",
      credentials: { folderId: "1MissingFolder_000000000000000000" },
    });
    expect((await setup.agent.sendTest(missing.id)).error).toBe(
      "Google Drive cannot find the folder or a file in it: check its address, and share it with the Google account signed in (404).",
    );
  });

  it("Slides and Drive keep no changelog; a 429 is retried after its Retry-After", async () => {
    const setup = await setUp();
    const rules = {
      actionNotices: true,
      infoNotices: true,
      workComplete: true,
      floorIds: [],
      changelog: true,
    };
    const slides = await setup.agent.add(
      folderRequest("google_slides", "Slides", slidesFolder, { rules }),
    );
    const drive = await setup.agent.add(
      folderRequest("google_drive", "Drive", driveFolder, { rules }),
    );
    expect(slides.rules).toEqual({
      actionNotices: false,
      infoNotices: false,
      workComplete: false,
      floorIds: [],
      changelog: false,
    });
    expect(drive.rules.changelog).toBe(false);
    await setup.signIn();
    await setup.bus.publish(merged(11, 1));
    await setup.run();
    expect(await setup.agent.deliveries(slides.id)).toEqual([]);
    expect(await setup.agent.deliveries(drive.id)).toEqual([]);

    // Each one's first request is answered 429.
    setup.google.rateLimit(2, 30);
    await setup.bus.publish(finished);
    await setup.run();
    for (const { id } of [slides, drive]) {
      const [limited] = await setup.agent.deliveries(id);
      expect(limited?.error).toBe(
        "Google Drive is rate-limiting this Connection (429).",
      );
      expect(limited?.nextAttemptAt).toEqual(
        new Date(start.getTime() + 30_000),
      );
    }
    setup.advance(30_000);
    await setup.agent.deliverDue();
    for (const { id } of [slides, drive]) {
      expect((await setup.agent.deliveries(id))[0]).toMatchObject({
        status: "delivered",
      });
    }
    expect(setup.google.files(slidesFolder)).toHaveLength(1);
    expect(setup.google.files(driveFolder)).toHaveLength(2);
  });
});
