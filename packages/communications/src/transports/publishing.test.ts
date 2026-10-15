import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createRedactor, defaultPublishingRules } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCommunications,
  type Communications,
} from "../communications.ts";
import type { BatchReport, ReportRequest, ReportWriter } from "../report.ts";
import { memoryCommunicationsStore } from "../store.ts";
import {
  serveFakeConfluence,
  serveFakeNotion,
  type FakeConfluence,
  type FakeNotion,
} from "../testing.ts";
import { confluenceTransport } from "./confluence.ts";
import { defaultTransports } from "./defaults.ts";
import { notionTransport } from "./notion.ts";

// The publishing destinations' contract (PRD FR-91, FR-92, FR-95), against
// a fake Confluence and a fake Notion that answer as theirs do: a finished
// Batch creates exactly one page with its Wrap-up report, even when an
// answer is lost and the delivery retried; with a running changelog each
// merged pull request is appended once; the report is at each Connection's
// detail level, redacted, and what it quotes is only ever text; its summary
// is written by the Communications Agent's Model from structured data; and
// "Send test" only reads.

const start = new Date("2026-10-10T11:00:00.000Z");
const publicUrl = "https://office.example.com";
const email = "owner@example.com";
const apiToken = "ATATT3xFfGF0-confluence-api-token-0123456789";
const notionToken = "ntn_fakeNotionIntegrationToken0123456789AB";
const parentPageId = "123456";
const notionParent = "1f2e3d4c5b6a79881f2e3d4c5b6a7988";
const notionDatabase = "aaaabbbbccccddddeeeeffff00001111";
const anthropicKey = "sk-ant-api03-pastedintoanissue-Qw3Er4Ty5Ui6Op7As8Df9";
const pull = (number: number) =>
  `https://github.com/adrianeyre/web-shop/pull/${String(number)}`;

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
  readonly confluence: FakeConfluence;
  readonly notion: FakeNotion;
  readonly bus: EventBus;
  readonly agent: Communications;
  /** What the Model was asked to write. */
  readonly asked: ReportRequest[];
  readonly advance: (ms: number) => void;
  /** Takes every event in, and sends what is due. */
  readonly run: () => Promise<void>;
}

async function setUp(
  notionOptions: { pageSize?: number } = {},
): Promise<Setup> {
  const confluence = await serveFakeConfluence({
    email,
    apiToken,
    spaces: [{ key: "ENG", id: "65537" }],
    parentPageId,
  });
  const notion = await serveFakeNotion({
    token: notionToken,
    parentPages: [notionParent],
    databases: [{ id: notionDatabase, titleProperty: "Name" }],
    ...notionOptions,
  });
  servers.push(confluence, notion);
  const clock = { time: start };
  const bus = createEventBus({
    store: memoryEventStore(),
    now: () => clock.time,
  });
  const asked: ReportRequest[] = [];
  const reportWriter: ReportWriter = {
    write(request) {
      asked.push(structuredClone(request));
      return Promise.resolve(modelSummary);
    },
  };
  const agent = createCommunications({
    store: memoryCommunicationsStore(),
    events: bus,
    encryptor: encryptorFromKey(Buffer.alloc(32, 5)),
    transports: {
      ...defaultTransports(),
      confluence: confluenceTransport({ timeoutMs: 2000 }),
      notion: notionTransport({ apiUrl: notion.apiUrl, timeoutMs: 2000 }),
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
    redactor: createRedactor(),
    now: () => clock.time,
    retry: { initialDelayMs: 1000 },
  });
  return {
    confluence,
    notion,
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
  };
}

const confluenceRequest = (
  setup: Setup,
  name: string,
  extra: Record<string, unknown> = {},
) =>
  ({
    type: "confluence",
    name,
    credentials: {
      siteUrl: setup.confluence.url,
      email,
      apiToken,
      spaceKey: "ENG",
      parentPageId,
    },
    ...extra,
  }) as Parameters<Communications["add"]>[0];

const notionRequest = (
  name: string,
  parent: "page" | "database",
  extra: Record<string, unknown> = {},
) =>
  ({
    type: "notion",
    name,
    credentials: {
      token: notionToken,
      parentType: parent,
      parentId: parent === "page" ? notionParent : notionDatabase,
    },
    ...extra,
  }) as Parameters<Communications["add"]>[0];

/** How often `needle` occurs in `text`. */
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("Confluence", () => {
  it("a finished Batch creates exactly one child page with its Wrap-up report, even when the answer is lost and it is sent again", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add(confluenceRequest(setup, "Wiki"));
    // Its first page's answer is lost: the page is made, the delivery fails.
    setup.confluence.loseNextAnswer();
    await setup.bus.publish(finished);
    await setup.run();
    expect(setup.confluence.childrenOf(parentPageId)).toHaveLength(1);
    const [first] = await setup.agent.deliveries(id);
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    expect(first?.error).toBe("Confluence answered 502.");

    // Tried again, it finds the page by its title, and makes no other.
    setup.advance(5000);
    await setup.agent.deliverDue();
    expect((await setup.agent.deliveries(id))[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
    });
    const pages = setup.confluence.childrenOf(parentPageId);
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page?.title).toBe("AI Office: Batch 3 Wrap-up (Web shop)");
    expect(page?.spaceId).toBe("65537");
    const body = page?.body ?? "";
    expect(body).toContain(
      "<h1>AI Office: Batch 3 Wrap-up (Web shop)</h1><p>Finished 10 Oct 2026, 10:50 UTC, on version 2 of the Plan: 1 of 3 issues merged, 1 blocked, 1 not started. 240,000 tokens, about $2.40 (estimated).</p>",
    );
    // The Plan, in its order, with its coders and dependencies.
    expect(body).toContain(
      '<ol><li><a href="https://github.com/adrianeyre/web-shop/issues/1">#1</a> Add a basket: Ada</li>',
    );
    expect(body).toContain("Pay at checkout, after #2</li></ol>");
    // Each issue's outcome, pull request, rounds, tokens and cost.
    expect(body).toContain(
      `<tr><td><a href="https://github.com/adrianeyre/web-shop/issues/1">#1</a> Add a basket</td><td>Merged</td><td><a href="${pull(11)}">PR #11</a></td><td>2, 1</td><td>150,000</td><td>$1.50</td></tr>`,
    );
    expect(body).toContain(
      "#4</a> Pay at checkout</td><td>Not started</td><td>None</td><td>0, 0</td><td>0</td><td>$0.00</td></tr>",
    );
    expect(body).toContain(
      "<tr><td><strong>Total</strong></td><td>1 of 3 issues merged, 1 blocked, 1 not started</td><td></td><td></td><td>240,000</td><td>$2.40</td></tr>",
    );
    expect(body).toContain(
      '<h2>Left out</h2><ul><li><a href="https://github.com/adrianeyre/web-shop/issues/6">#6</a>: it is closed</li></ul>',
    );
    expect(body).toContain(
      `<p><a href="${publicUrl}/floors/web-shop/whiteboard?batch=3">Open the Wrap-up in AI Office</a></p>`,
    );
    // The Communications Agent's Model wrote its summary.
    expect(body).toContain(
      "<h2>Summary</h2><p>One issue merged and one waits for the Owner. [Open](https://evil.example) [REDACTED]</p>",
    );
    // Before making it, it looked for it.
    const writes = setup.confluence.requests.filter(
      ({ method }) => method !== "GET",
    );
    expect(writes).toEqual([{ method: "POST", path: "/wiki/api/v2/pages" }]);
  });

  it("the changelog: one page, made with the first entry, and each merged pull request appended once, a lost answer included", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add(
      confluenceRequest(setup, "Changelog", {
        rules: {
          ...defaultPublishingRules,
          changelog: true,
          floorIds: ["web-shop"],
        },
      }),
    );
    await setup.bus.publish(merged(11, 1));
    // Another Floor's merge is not this Connection's.
    await setup.bus.publish(merged(31, 21, "blog"));
    setup.advance(60_000);
    await setup.bus.publish(merged(12, 2));
    await setup.run();
    expect(await setup.agent.deliveries(id)).toHaveLength(2);
    const changelog = () =>
      setup.confluence.pages.filter(
        ({ title }) => title === "AI Office changelog",
      );
    expect(changelog()).toHaveLength(1);

    // The third entry's answer is lost.
    setup.confluence.loseNextAnswer();
    await setup.bus.publish(merged(13, 4));
    await setup.run();
    const statuses = async () =>
      new Map(
        (await setup.agent.deliveries(id)).map(({ message, status }) => [
          message.githubUrl,
          status,
        ]),
      );
    expect(await statuses()).toEqual(
      new Map([
        [pull(11), "delivered"],
        [pull(12), "delivered"],
        [pull(13), "pending"],
      ]),
    );
    setup.advance(5000);
    await setup.agent.deliverDue();

    const [page] = changelog();
    expect(changelog()).toHaveLength(1);
    expect(page?.parentId).toBe(parentPageId);
    const body = page?.body ?? "";
    for (const number of [11, 12, 13]) {
      expect(count(body, `href="${pull(number)}"`)).toBe(1);
    }
    expect(body).not.toContain(pull(31));
    expect(body).toContain(
      `<p><strong>2026-10-10</strong> · Web shop · <a href="${pull(11)}">Pull request #11 merged, closing issue #1: Add a basket</a></p>`,
    );
    // The issue's title is redacted there too.
    expect(body).toContain(
      `<a href="${pull(12)}">Pull request #12 merged, closing issue #2: Show the total [REDACTED]</a>`,
    );
    expect(body.indexOf(pull(11))).toBeLessThan(body.indexOf(pull(12)));
    expect(body.indexOf(pull(12))).toBeLessThan(body.indexOf(pull(13)));
    expect(page?.version).toBe(4);
    // No report page: no Batch finished.
    expect(setup.confluence.childrenOf(parentPageId)).toHaveLength(1);
  });

  it("without a changelog, merges publish nothing; Notices are never a publishing destination's", async () => {
    const setup = await setUp();
    const { id, rules } = await setup.agent.add(
      confluenceRequest(setup, "Reports only", {
        // Notification triggers are not a publishing destination's.
        rules: {
          actionNotices: true,
          infoNotices: true,
          workComplete: true,
          floorIds: [],
          quietHours: {
            start: "22:00",
            end: "07:00",
            timeZone: "Europe/London",
            actionNotices: false,
          },
        },
      }),
    );
    expect(rules).toEqual(defaultPublishingRules);
    await setup.bus.publish(merged(11, 1));
    await setup.bus.publish({
      type: "notice.raised",
      version: 1,
      noticeId: "notice-9",
      kind: "action",
      title: "PR #14 awaiting your approval",
      floorId: "web-shop",
    });
    await setup.run();
    expect(await setup.agent.deliveries(id)).toEqual([]);
    expect(setup.confluence.pages).toHaveLength(1);
    // Changed later, it keeps only its Floors and its changelog.
    const changed = await setup.agent.update(id, {
      rules: {
        actionNotices: true,
        infoNotices: false,
        workComplete: true,
        floorIds: ["web-shop"],
        changelog: true,
      },
    });
    expect(changed.rules).toEqual({
      ...defaultPublishingRules,
      floorIds: ["web-shop"],
      changelog: true,
    });
  });

  it("Send test only reads the space and the parent page; refused credentials say so, without the token", async () => {
    const setup = await setUp();
    const good = await setup.agent.add(confluenceRequest(setup, "Wiki"));
    expect(await setup.agent.sendTest(good.id)).toMatchObject({
      delivered: true,
      error: null,
    });
    expect(
      setup.confluence.requests.map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "GET /wiki/api/v2/spaces",
      `GET /wiki/api/v2/pages/${parentPageId}`,
    ]);
    const bad = await setup.agent.add({
      ...confluenceRequest(setup, "Wrong token"),
      credentials: {
        siteUrl: setup.confluence.url,
        email,
        apiToken: "ATATT3xFfGF0-a-wrong-token-9876543210",
        spaceKey: "ENG",
        parentPageId,
      },
    } as Parameters<Communications["add"]>[0]);
    const refused = await setup.agent.sendTest(bad.id);
    expect(refused).toMatchObject({
      delivered: false,
      error: "Confluence refused the email and API token (401).",
    });
    expect(setup.confluence.pages).toHaveLength(1);
    expect(JSON.stringify(await setup.agent.list())).not.toContain(apiToken);
  });

  it("a 429 is retried after its Retry-After", async () => {
    const setup = await setUp();
    const { id } = await setup.agent.add(confluenceRequest(setup, "Wiki"));
    setup.confluence.rateLimit(1, 7);
    await setup.bus.publish(finished);
    await setup.run();
    const [delivery] = await setup.agent.deliveries(id);
    expect(delivery?.error).toBe(
      "Confluence is rate-limiting this Connection (429).",
    );
    expect(delivery?.nextAttemptAt).toEqual(new Date(start.getTime() + 7000));
  });
});

describe("Notion", () => {
  it("a finished Batch creates exactly one page under the parent page, with its report as blocks, even when the answer is lost", async () => {
    const setup = await setUp({ pageSize: 2 });
    const { id } = await setup.agent.add(notionRequest("Notes", "page"));
    setup.notion.loseNextAnswer();
    await setup.bus.publish(finished);
    await setup.run();
    expect((await setup.agent.deliveries(id))[0]?.status).toBe("pending");
    setup.advance(5000);
    await setup.agent.deliverDue();
    expect((await setup.agent.deliveries(id))[0]?.status).toBe("delivered");

    expect(setup.notion.pages).toHaveLength(1);
    const [page] = setup.notion.pages;
    expect(page?.title).toBe("AI Office: Batch 3 Wrap-up (Web shop)");
    expect(page?.parent).toEqual({ type: "page_id", page_id: notionParent });
    const types = page?.blocks.map(({ type }) => type);
    expect(types?.slice(0, 4)).toEqual([
      "heading_1",
      "paragraph",
      "heading_2",
      "paragraph",
    ]);
    const table = page?.blocks.find(({ type }) => type === "table") as
      | {
          table: {
            table_width: number;
            children: {
              table_row: {
                cells: {
                  text: { content: string; link: { url: string } | null };
                }[][];
              };
            }[];
          };
        }
      | undefined;
    expect(table?.table.table_width).toBe(6);
    const rows = table?.table.children.map(({ table_row }) =>
      table_row.cells.map((cell) =>
        cell.map(({ text }) => text.content).join(""),
      ),
    );
    expect(rows?.[0]).toEqual([
      "Issue",
      "Outcome",
      "Pull request",
      "Rounds (review, QA)",
      "Tokens",
      "Estimated cost",
    ]);
    expect(rows?.[1]).toEqual([
      "#1 Add a basket",
      "Merged",
      "PR #11",
      "2, 1",
      "150,000",
      "$1.50",
    ]);
    expect(rows?.[4]).toEqual([
      "Total",
      "1 of 3 issues merged, 1 blocked, 1 not started",
      "",
      "",
      "240,000",
      "$2.40",
    ]);
    expect(
      table?.table.children[1]?.table_row.cells[2]?.[0]?.text.link,
    ).toEqual({
      url: pull(11),
    });
  });

  it("in a database: one page found by its title property; and the changelog appended once per merge", async () => {
    const setup = await setUp({ pageSize: 2 });
    const { id } = await setup.agent.add(
      notionRequest("Work log", "database", {
        rules: { ...defaultPublishingRules, changelog: true },
      }),
    );
    await setup.bus.publish(finished);
    await setup.bus.publish(merged(11, 1));
    await setup.bus.publish(merged(12, 2));
    await setup.run();
    setup.notion.loseNextAnswer();
    await setup.bus.publish(merged(13, 4));
    await setup.run();
    setup.advance(5000);
    await setup.agent.deliverDue();
    expect(
      (await setup.agent.deliveries(id)).map(({ status }) => status),
    ).toEqual(["delivered", "delivered", "delivered", "delivered"]);

    expect(
      setup.notion.pages.map(({ title, parent }) => [title, parent]),
    ).toEqual([
      [
        "AI Office: Batch 3 Wrap-up (Web shop)",
        { type: "database_id", database_id: notionDatabase },
      ],
      [
        "AI Office changelog",
        { type: "database_id", database_id: notionDatabase },
      ],
    ]);
    const changelog = setup.notion.pages[1];
    const entries = (changelog?.blocks ?? []).filter(
      ({ type }) => type === "bulleted_list_item",
    );
    const text = JSON.stringify(entries);
    for (const number of [11, 12, 13]) {
      expect(count(text, `"url":"${pull(number)}"`)).toBe(1);
    }
    expect(entries).toHaveLength(3);
    expect(text).toContain(
      "Pull request #12 merged, closing issue #2: Show the total [REDACTED]",
    );
    expect(text).not.toContain(anthropicKey);
  });

  it("Send test only reads the parent; a parent not shared with the integration says so", async () => {
    const setup = await setUp();
    const good = await setup.agent.add(notionRequest("Notes", "page"));
    expect((await setup.agent.sendTest(good.id)).delivered).toBe(true);
    const unshared = await setup.agent.add({
      ...notionRequest("Elsewhere", "page"),
      credentials: {
        token: notionToken,
        parentType: "page",
        parentId: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000",
      },
    } as Parameters<Communications["add"]>[0]);
    expect(await setup.agent.sendTest(unshared.id)).toMatchObject({
      delivered: false,
      error:
        "Notion cannot reach the parent page: share it with the integration (404).",
    });
    expect(setup.notion.requests.every(({ method }) => method === "GET")).toBe(
      true,
    );
    expect(setup.notion.pages).toEqual([]);
  });
});

describe("detail levels and redaction in a report", () => {
  it('"titles and summaries": titles, the Floor and Agents named, every credential redacted, and what a title or the summary says only ever text', async () => {
    const setup = await setUp();
    await setup.agent.add(confluenceRequest(setup, "Wiki"));
    await setup.agent.add(notionRequest("Notes", "page"));
    await setup.bus.publish(finished);
    await setup.run();

    const body = setup.confluence.childrenOf(parentPageId)[0]?.body ?? "";
    const blocks = JSON.stringify(setup.notion.pages[0]?.blocks);
    for (const published of [body, blocks]) {
      expect(published).not.toContain(anthropicKey);
      expect(published).not.toContain("sk-ant-");
      expect(published).toContain("[REDACTED]");
      expect(published).toContain("Web shop");
      expect(published).toContain("Ada");
    }
    // The title's Markdown is text: no link to it, no bold, no extra cell.
    expect(body).toContain(
      "#2</a> Show the total | **now** [click](https://evil.example) [REDACTED]</td><td>Blocked</td>",
    );
    expect(body).not.toContain('href="https://evil.example"');
    expect(blocks).not.toContain('"url":"https://evil.example"');

    // The Model was asked once, for both, with structured data only.
    expect(setup.asked).toHaveLength(1);
    const [request] = setup.asked;
    expect(request).toMatchObject({
      agentName: "Reception",
      model: "claude-haiku-5-5",
    });
    expect(request?.data).toEqual({
      batch: 3,
      floor: "Web shop",
      counts: { ...batchReport.totals, issues: 3 },
      issues: [
        {
          issue: 1,
          title: "Add a basket",
          outcome: "Merged",
          reviewRounds: 2,
          qaRounds: 1,
          tokens: 150_000,
          estimatedCostUsd: 1.5,
        },
        {
          issue: 2,
          title:
            "Show the total | **now** [click](https://evil.example) [REDACTED]",
          outcome: "Blocked",
          reviewRounds: 3,
          qaRounds: 0,
          tokens: 90_000,
          estimatedCostUsd: 0.9,
        },
        {
          issue: 4,
          title: "Pay at checkout",
          outcome: "Not started",
          reviewRounds: 0,
          qaRounds: 0,
          tokens: 0,
          estimatedCostUsd: 0,
        },
      ],
    });
  });

  it('"links only": kinds, counts and links; no Floor name, issue title, Agent or reason, and no Model call', async () => {
    const setup = await setUp();
    const wiki = await setup.agent.add({
      ...confluenceRequest(setup, "Wiki"),
      detailLevel: "links_only",
    });
    await setup.agent.add({
      ...notionRequest("Notes", "page", {
        rules: { ...defaultPublishingRules, changelog: true },
      }),
      detailLevel: "links_only",
    });
    await setup.bus.publish(finished);
    await setup.bus.publish(merged(11, 1));
    await setup.run();

    const [page] = setup.confluence.childrenOf(parentPageId);
    expect(page?.title).toBe("AI Office: Batch 3 Wrap-up");
    const notionReport = setup.notion.pages.find(
      ({ title }) => title === "AI Office: Batch 3 Wrap-up",
    );
    const notionChangelog = setup.notion.pages.find(
      ({ title }) => title === "AI Office changelog",
    );
    for (const published of [
      page?.body ?? "",
      JSON.stringify(notionReport?.blocks),
      JSON.stringify(notionChangelog?.blocks),
    ]) {
      for (const hidden of [
        "Web shop",
        "Add a basket",
        "Show the total",
        "Pay at checkout",
        "Ada",
        "Alan",
        "it is closed",
        "One issue merged",
      ]) {
        expect(published).not.toContain(hidden);
      }
    }
    const body = page?.body ?? "";
    expect(body).toContain(
      `<tr><td><a href="https://github.com/adrianeyre/web-shop/issues/1">#1</a></td><td>Merged</td><td><a href="${pull(11)}">PR #11</a></td><td>2, 1</td><td>150,000</td><td>$1.50</td></tr>`,
    );
    expect(body).toContain(
      "<h2>Summary</h2><p>Batch 3 finished: 1 of 3 issues merged, 1 blocked, 1 not started, using 240,000 tokens (about $2.40, estimated). #2 waits for the Owner.</p>",
    );
    expect(JSON.stringify(notionChangelog?.blocks)).toContain(
      `"content":"Pull request merged","link":{"url":"${pull(11)}"}`,
    );
    expect(setup.asked).toEqual([]);
    expect((await setup.agent.deliveries(wiki.id))[0]?.message).toMatchObject({
      kind: "report",
      title: "AI Office: Batch 3 Wrap-up",
      floor: null,
    });
  });
});
