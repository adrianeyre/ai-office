import { postgresTest } from "@ai-office/db/testing";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  createChatRepositoryFiles,
  databaseStores,
  memoryStores,
  type ModelClient,
  type ModelRequest,
  type ModelStreamOptions,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  chatAttachmentSchema,
  managerChatFileListSchema,
  managerChatTaskListSchema,
  maxChatTextBytes,
  type ManagerChatTask,
  grillingSessionDetailSchema,
  grillingSessionListSchema,
  grillingSessionSchema,
  managerChatFrameSchema,
  managerChatSchema,
  managerChatSendResponseSchema,
  type ManagerChatFrame,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type AppOptions } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The Manager chat API (PRD FR-24, §8): messages sent over REST; commands
// answered at once in plain code; anything else streamed from the
// Manager's Model over server-sent events, resuming after the last message
// a client has. The model client stands in for the AI Gateway.

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/**
 * A model that writes "Start " at once, and "with #4." once released
 * (before or after it is called); stopped (or interrupted) first, it fails.
 */
function heldModel() {
  const requests: ModelRequest[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: ModelClient = {
    complete: () => Promise.reject(new Error("The chat streams its calls.")),
    async stream(
      request: ModelRequest,
      { onText, signal }: ModelStreamOptions,
    ) {
      requests.push(request);
      onText("Start ");
      await Promise.race([
        released,
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
      ]);
      onText("with #4.");
      return { text: "Start with #4.", stopReason: "end_turn" };
    },
  };
  return { client, requests, release };
}

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly baseUrl: string;
  readonly model: ReturnType<typeof heldModel>;
  readonly logged: string[];
  readonly managerId: string;
  readonly github: FakeGitHub;
}

async function setUp(
  stores: OfficeStores = memoryStores(),
  models?: ModelClient,
  extra: (
    github: FakeGitHub,
    stores: OfficeStores,
  ) => Partial<Pick<AppOptions, "chatFiles" | "chatTasks">> = () => ({}),
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const model = heldModel();
  const logged: string[] = [];
  const server = await buildApp({
    logger: createLogger({
      level: "info",
      secrets: [],
      destination: {
        write(line: string) {
          logged.push(line);
        },
      },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    stores,
    github,
    models: models ?? model.client,
    ...extra(github, stores),
  });
  servers.push(server);
  const owner = await signIn(server);
  const added = await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  if (added.statusCode === 409) {
    // Kept from an earlier app on the same database.
  } else {
    expect(added.statusCode).toBe(201);
  }
  const managerId =
    (await stores.agents.list("web-shop")).find(
      ({ role }) => role === "manager",
    )?.id ?? "";
  const baseUrl = await server.listen({ port: 0, host: "127.0.0.1" });
  return { server, owner, baseUrl, model, logged, managerId, github };
}

const send = ({ server, owner }: Setup, text: unknown, floorId = "web-shop") =>
  server.inject({
    method: "POST",
    url: `/api/floors/${floorId}/manager-chat/messages`,
    headers: owner.headers,
    payload: { text },
  });

const history = async ({ server, owner }: Setup) =>
  managerChatSchema.parse(
    (
      await server.inject({
        url: "/api/floors/web-shop/manager-chat",
        headers: owner.headers,
      })
    ).json(),
  );

/** An open chat stream, read one frame at a time. */
async function stream(setup: Setup, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(
    `${setup.baseUrl}/api/floors/web-shop/manager-chat/stream`,
    {
      headers: { cookie: setup.owner.cookie, ...headers },
      signal: controller.signal,
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "text/event-stream; charset=utf-8",
  );
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    /** The next frame with data: its id, if it has one, and data. */
    async next(): Promise<{ id: number | undefined; frame: ManagerChatFrame }> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const text = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: (\d+)$/m.exec(text)?.[1];
          const data = /^data: (.*)$/m.exec(text)?.[1];
          if (data !== undefined) {
            return {
              id: id === undefined ? undefined : Number(id),
              frame: managerChatFrameSchema.parse(JSON.parse(data)),
            };
          }
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("The stream ended.");
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close() {
      controller.abort();
    },
  };
}

describe("sending", () => {
  it("answers a command at once, in plain code, with what it understood", async () => {
    const setup = await setUp();
    const response = await send(setup, "complete issues 1 to 3");
    expect(response.statusCode).toBe(201);
    const { message, reply } = managerChatSendResponseSchema.parse(
      response.json(),
    );
    expect(message).toMatchObject({
      id: 1,
      kind: "owner",
      text: "complete issues 1 to 3",
    });
    expect(reply).toMatchObject({
      id: 2,
      kind: "command",
      command: { kind: "complete", issues: [1, 2, 3] },
      text: "Understood: complete 3 issues: #1, #2 and #3. Batches are not available here, so nothing was started.",
      replyTo: 1,
      agentId: setup.managerId,
    });
    const typo = managerChatSendResponseSchema.parse(
      (await send(setup, "mvoe 5 up")).json(),
    );
    expect(typo.reply).toMatchObject({
      kind: "hint",
      text: 'I did not understand that. Did you mean "move 5 up"?',
    });
    expect(setup.model.requests).toEqual([]);

    const chat = await history(setup);
    expect(chat.manager).toEqual({
      id: setup.managerId,
      name: expect.any(String) as string,
      aiProvider: "Claude",
      model: "claude-opus-5-5",
    });
    expect(chat.messages.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    expect(chat.pending).toEqual([]);
    // What kind of answer is logged, never the Owner's words.
    const log = setup.logged.join("");
    expect(log).toContain("The Owner wrote to a Floor's Manager.");
    expect(log).toContain('"answer":"command"');
    expect(log).not.toContain("mvoe");
  });

  it("runs one of the Floor's Skills with /name, loading it for the Manager's Model (FR-74)", async () => {
    const setup = await setUp();
    const added = await setup.server.inject({
      method: "POST",
      url: "/api/skills",
      headers: setup.owner.headers,
      payload: {
        source: "editor",
        files: [
          {
            path: "SKILL.md",
            content:
              "---\nname: release-notes\ndescription: Writes release notes.\n---\n\nList every merged pull request.\n",
          },
        ],
      },
    });
    expect(added.statusCode).toBe(201);
    const response = await send(setup, "/release-notes for 1.2");
    expect(response.statusCode).toBe(201);
    const sent = managerChatSendResponseSchema.parse(response.json());
    expect(sent.reply).toBeNull();
    expect(sent.message.skill).toEqual({
      name: "release-notes",
      source: "office",
      arguments: "for 1.2",
      chosenBy: "owner",
    });
    await expect.poll(() => setup.model.requests.length).toBe(1);
    expect(setup.model.requests[0]?.system).toContain(
      "### /release-notes (from the office Skill library)\n\nList every merged pull request.",
    );
    setup.model.release();
    await expect
      .poll(async () => (await history(setup)).messages.at(-1)?.kind)
      .toBe("reply");
    expect((await history(setup)).messages[0]?.skill?.name).toBe(
      "release-notes",
    );

    // A name the Floor has no Skill of is a hint, at once.
    const unknown = managerChatSendResponseSchema.parse(
      (await send(setup, "/nothing-here")).json(),
    );
    expect(unknown.reply).toMatchObject({
      kind: "hint",
      text: "There is no Skill /nothing-here on this Floor. Its Skills are /code-review, /codebase-design, /diagnosing-bugs, /domain-modeling, /grill-with-docs, /grilling, /pr, /prototype, /release-notes, /research, /tdd, /to-spec, /to-tickets and /wayfinder.",
      skill: null,
    });
  });

  it("refuses an empty, overlong or malformed message", async () => {
    const setup = await setUp();
    for (const text of ["", "   ", "x".repeat(8001), 4]) {
      expect((await send(setup, text)).statusCode).toBe(400);
    }
    const extra = await setup.server.inject({
      method: "POST",
      url: "/api/floors/web-shop/manager-chat/messages",
      headers: setup.owner.headers,
      payload: { text: "pause", issue: 4 },
    });
    expect(extra.statusCode).toBe(400);
    expect((await history(setup)).messages).toEqual([]);
  });

  it("refuses an unknown Floor and an archived one; a message while the Manager writes interrupts it", async () => {
    const setup = await setUp();
    const unknown = await send(setup, "pause", "nowhere");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "floor_not_found" });
    expect(
      (
        await setup.server.inject({
          url: "/api/floors/nowhere/manager-chat",
          headers: setup.owner.headers,
        })
      ).statusCode,
    ).toBe(404);

    expect((await send(setup, "Plan it?")).statusCode).toBe(201);
    // Written so far: "Start ". The Owner's next message interrupts it
    // (FR-24), keeping what it wrote, and is taken.
    const interrupting = await send(setup, "pause");
    expect(interrupting.statusCode).toBe(201);
    expect(
      (await history(setup)).messages.map(({ kind, text }) => [kind, text]),
    ).toEqual([
      ["owner", "Plan it?"],
      ["reply", "Start\n\n(Interrupted by the Owner.)"],
      ["owner", "pause"],
      [
        "command",
        "Understood: pause this Floor's work. Pausing a Floor is not available yet, so nothing changed.",
      ],
    ]);
    setup.model.release();

    await setup.server.inject({
      method: "POST",
      url: "/api/floors/web-shop/archive",
      headers: setup.owner.headers,
    });
    const archived = await send(setup, "pause");
    expect(archived.statusCode).toBe(409);
    expect(archived.json()).toMatchObject({ error: "floor_archived" });
  });

  it("needs a session, and the CSRF token to send", async () => {
    const setup = await setUp();
    for (const [method, url] of [
      ["GET", "/api/floors/web-shop/manager-chat"],
      ["GET", "/api/floors/web-shop/manager-chat/stream"],
      ["POST", "/api/floors/web-shop/manager-chat/messages"],
    ] as const) {
      expect(
        (await setup.server.inject({ method, url, payload: {} })).statusCode,
        url,
      ).toBe(401);
    }
    const noToken = await setup.server.inject({
      method: "POST",
      url: "/api/floors/web-shop/manager-chat/messages",
      headers: { cookie: setup.owner.cookie },
      payload: { text: "pause" },
    });
    expect(noToken.statusCode).toBe(403);
  });
});

describe("the stream", () => {
  it("streams the Manager's reply a piece at a time, then the reply as kept", async () => {
    const setup = await setUp();
    const live = await stream(setup);
    const sent = managerChatSendResponseSchema.parse(
      (await send(setup, "What should we work on first?")).json(),
    );
    expect(sent.reply).toBeNull();
    expect(await live.next()).toEqual({
      id: 1,
      frame: { type: "message", message: sent.message },
    });
    expect(await live.next()).toEqual({
      id: undefined,
      frame: { type: "delta", replyTo: 1, text: "Start " },
    });
    // Meanwhile, the history has the reply so far.
    expect((await history(setup)).pending).toEqual([
      { replyTo: 1, text: "Start " },
    ]);
    setup.model.release();
    expect(await live.next()).toEqual({
      id: undefined,
      frame: { type: "delta", replyTo: 1, text: "with #4." },
    });
    const kept = await live.next();
    expect(kept).toMatchObject({
      id: 2,
      frame: {
        type: "message",
        message: {
          kind: "reply",
          text: "Start with #4.",
          replyTo: 1,
          agentId: setup.managerId,
          model: "claude-opus-5-5",
        },
      },
    });
    live.close();
    expect(setup.model.requests[0]).toMatchObject({
      agentId: setup.managerId,
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "What should we work on first?" }],
    });
    const log = setup.logged.join("");
    expect(log).toContain('"answer":"model"');
    expect(log).not.toContain("work on first");
  });

  it("resumes after the last message a client has, from a reply's text so far", async () => {
    const setup = await setUp();
    await send(setup, "pause");
    await send(setup, "Plan it?");

    // Reconnecting with the last message it had (the command's answer):
    // the Owner's next message, then the reply being written so far.
    const resumed = await stream(setup, { "last-event-id": "2" });
    expect(await resumed.next()).toMatchObject({
      id: 3,
      frame: { type: "message", message: { text: "Plan it?" } },
    });
    expect(await resumed.next()).toEqual({
      id: undefined,
      frame: { type: "pending", replyTo: 3, text: "Start " },
    });
    setup.model.release();
    expect((await resumed.next()).frame).toEqual({
      type: "delta",
      replyTo: 3,
      text: "with #4.",
    });
    expect(await resumed.next()).toMatchObject({
      id: 4,
      frame: { type: "message", message: { kind: "reply" } },
    });
    resumed.close();

    // `?lastEventId=` does the same, for a browser's first connection.
    const fromQuery = await fetch(
      `${setup.baseUrl}/api/floors/web-shop/manager-chat/stream?lastEventId=x`,
      { headers: { cookie: setup.owner.cookie } },
    );
    expect(fromQuery.status).toBe(400);
    const again = await stream(setup, { "last-event-id": "3" });
    expect(await again.next()).toMatchObject({
      id: 4,
      frame: { type: "message", message: { kind: "reply" } },
    });
    again.close();
  });

  it("is a 404 for a Floor that does not exist", async () => {
    const setup = await setUp();
    const response = await fetch(
      `${setup.baseUrl}/api/floors/nowhere/manager-chat/stream`,
      { headers: { cookie: setup.owner.cookie } },
    );
    expect(response.status).toBe(404);
  });
});

describe("clearing and compacting (FR-87)", () => {
  it("answers /clear at once, and /compact with the Manager's summary", async () => {
    const setup = await setUp();
    setup.model.release();
    await send(setup, "What first?");
    await expect
      .poll(async () => (await history(setup)).messages.length)
      .toBe(2);

    const compacted = await send(setup, "/compact");
    expect(compacted.statusCode).toBe(201);
    expect(
      managerChatSendResponseSchema.parse(compacted.json()).reply,
    ).toBeNull();
    await expect
      .poll(async () => (await history(setup)).messages.at(-1)?.kind)
      .toBe("summary");
    expect((await history(setup)).messages.at(-1)).toMatchObject({
      text: "Start with #4.",
      replyTo: 3,
      compaction: {
        trigger: "owner",
        contextUsage: null,
        upTo: 3,
        messages: 3,
      },
    });
    // The summary was asked for in its own call, naming the conversation.
    expect(setup.model.requests[1]).toMatchObject({
      agentId: setup.managerId,
      session: "manager-chat:web-shop:0",
    });

    const cleared = managerChatSendResponseSchema.parse(
      (await send(setup, "/clear")).json(),
    );
    expect(cleared.message).toMatchObject({ kind: "owner", skill: null });
    expect(cleared.reply).toMatchObject({
      kind: "clear",
      compaction: null,
      tools: [],
      attachments: [],
    });
    expect(cleared.reply?.text).toMatch(/^Cleared the conversation: /);
    expect(setup.model.requests).toHaveLength(2);
  });
});

describe("Grilling Sessions", () => {
  /** A model that asks one question, then none. */
  const grillingModel = (): ModelClient => {
    const turns = [
      {
        questions: [{ text: "CSV or JSON?", recommended: "CSV." }],
      },
      {
        decisions: [{ text: "Exports are CSV.", questions: [1] }],
        questions: [],
      },
    ];
    return {
      complete: () => Promise.reject(new Error("The chat streams its calls.")),
      stream: () =>
        Promise.resolve({
          text: JSON.stringify(turns.shift() ?? {}),
          stopReason: "end_turn",
        }),
    };
  };

  it("lists a Floor's sessions and reads one with its decisions and every message", async () => {
    const setup = await setUp(memoryStores(), grillingModel());
    expect((await send(setup, "/grilling exports")).statusCode).toBe(201);
    await expect
      .poll(async () => (await history(setup)).messages.length)
      .toBe(2);
    const [, round] = (await history(setup)).messages;
    expect(round).toMatchObject({
      kind: "reply",
      grilling: { sessionId: 1, round: 1 },
    });
    await send(setup, "recommended to all");
    await expect
      .poll(async () => (await history(setup)).messages.length)
      .toBe(4);
    const ended = managerChatSendResponseSchema.parse(
      (await send(setup, "confirm")).json(),
    );
    expect(ended.reply).toMatchObject({
      kind: "grilling",
      grilling: { sessionId: 1, round: null },
    });

    const listed = await setup.server.inject({
      url: "/api/floors/web-shop/grilling-sessions",
      headers: setup.owner.headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(grillingSessionListSchema.parse(listed.json()).sessions).toEqual([
      expect.objectContaining({
        id: 1,
        topic: "exports",
        status: "ended",
        round: 1,
        openQuestions: 0,
        decisionCount: 1,
      }),
    ]);
    const read = await setup.server.inject({
      url: "/api/floors/web-shop/grilling-sessions/1",
      headers: setup.owner.headers,
    });
    expect(read.statusCode).toBe(200);
    const detail = grillingSessionDetailSchema.parse(read.json());
    expect(detail.session).toMatchObject({
      status: "ended",
      questions: [
        {
          number: 1,
          round: 1,
          text: "CSV or JSON?",
          status: "answered",
          answer: "CSV.",
          acceptedRecommended: true,
        },
      ],
      decisions: [{ number: 1, text: "Exports are CSV.", questions: [1] }],
      terms: [],
    });
    expect(detail.messages.map(({ kind }) => kind)).toEqual([
      "owner",
      "reply",
      "owner",
      "reply",
      "owner",
      "grilling",
    ]);

    // None of that number, or not a number; no Floor; no session.
    for (const [url, status] of [
      ["/api/floors/web-shop/grilling-sessions/2", 404],
      ["/api/floors/web-shop/grilling-sessions/x", 404],
      ["/api/floors/nowhere/grilling-sessions", 404],
    ] as const) {
      const response = await setup.server.inject({
        url,
        headers: setup.owner.headers,
      });
      expect(response.statusCode).toBe(status);
    }
    const signedOut = await setup.server.inject({
      url: "/api/floors/web-shop/grilling-sessions",
    });
    expect(signedOut.statusCode).toBe(401);
  });

  it("keeps the Owner's edits to an ended session's draft issues, refusing drafts that cannot be filed", async () => {
    const stores = memoryStores();
    const setup = await setUp(stores, grillingModel());
    await send(setup, "/grilling exports");
    await expect
      .poll(async () => (await history(setup)).messages.length)
      .toBe(2);
    await send(setup, "recommended to all");
    await expect
      .poll(async () => (await history(setup)).messages.length)
      .toBe(4);
    await send(setup, "confirm");
    const put = (drafts: unknown, sessionId: number | string = 1) =>
      setup.server.inject({
        method: "PUT",
        url: `/api/floors/web-shop/grilling-sessions/${String(sessionId)}/issues`,
        headers: setup.owner.headers,
        payload: { drafts },
      });
    const draft = (id: number, title: string, blockedBy: number[] = []) => ({
      id,
      title,
      whatToBuild: `Build ${title}.`,
      acceptanceCriteria: [`${title} works`],
      blockedBy,
      prdSections: [],
      adrs: [],
    });

    // Not drafted yet.
    expect((await put([draft(1, "Export")])).json()).toMatchObject({
      error: "grilling_issues_not_editable",
    });
    const ended = await stores.grilling.get("web-shop", 1);
    if (ended === undefined) {
      throw new Error("The session is kept.");
    }
    await stores.grilling.save({
      ...ended,
      issues: {
        drafts: [
          { ...draft(1, "Export"), filed: null },
          { ...draft(2, "Email", [1]), filed: null },
        ],
        draftedAt: "2026-10-10T12:00:00.000Z",
        approvedAt: null,
        problem: null,
      },
    });

    // Reordered and edited: kept in that order.
    const saved = await put([
      { ...draft(2, "Email the export", [1]), adrs: [] },
      draft(1, "Export"),
    ]);
    expect(saved.statusCode).toBe(200);
    expect(
      grillingSessionSchema
        .parse(saved.json())
        .issues?.drafts.map(({ id, title, filed }) => [id, title, filed]),
    ).toEqual([
      [2, "Email the export", null],
      [1, "Export", null],
    ]);

    for (const [drafts, status, error] of [
      [
        [draft(1, "A", [2]), draft(2, "B", [1])],
        400,
        "grilling_issues_invalid",
      ],
      [[draft(1, "A", [9])], 400, "grilling_issues_invalid"],
      [[{ ...draft(1, "A"), acceptanceCriteria: [] }], 400, "invalid_request"],
      [[], 400, "invalid_request"],
    ] as const) {
      const refused = await put(drafts);
      expect(refused.statusCode).toBe(status);
      expect(refused.json()).toMatchObject({ error });
    }
    expect((await put([draft(1, "A")], 2)).statusCode).toBe(404);
    const signedOut = await setup.server.inject({
      method: "PUT",
      url: "/api/floors/web-shop/grilling-sessions/1/issues",
      payload: { drafts: [draft(1, "A")] },
    });
    expect(signedOut.statusCode).toBe(401);
  });
});

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const upload = (
  { server, owner }: Setup,
  payload: unknown,
  headers: Record<string, string> = owner.headers,
) =>
  server.inject({
    method: "POST",
    url: "/api/floors/web-shop/manager-chat/attachments",
    headers,
    payload: payload as Record<string, unknown>,
  });

describe("attachments (FR-24)", () => {
  it("keeps an image or a text file, unsent, and serves it back as itself", async () => {
    const setup = await setUp();
    const image = await upload(setup, {
      name: "checkout.png",
      mediaType: "image/png",
      content: png.toString("base64"),
    });
    expect(image.statusCode).toBe(201);
    const shot = chatAttachmentSchema.parse(image.json());
    expect(shot).toMatchObject({
      name: "checkout.png",
      mediaType: "image/png",
      size: png.length,
    });
    const served = await setup.server.inject({
      url: `/api/floors/web-shop/manager-chat/attachments/${shot.id}`,
      headers: setup.owner.headers,
    });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(png);
    expect(served.headers).toMatchObject({
      "content-type": "image/png",
      "content-disposition": `inline; filename="checkout.png"; filename*=UTF-8''checkout.png`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; sandbox",
    });

    const text = await upload(setup, {
      name: 'build "log".txt',
      mediaType: "text/plain",
      content: Buffer.from("<script>alert(1)</script>").toString("base64"),
    });
    expect(text.statusCode).toBe(201);
    const log = chatAttachmentSchema.parse(text.json());
    const downloaded = await setup.server.inject({
      url: `/api/floors/web-shop/manager-chat/attachments/${log.id}`,
      headers: setup.owner.headers,
    });
    expect(downloaded.headers).toMatchObject({
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="build _log_.txt"; filename*=UTF-8''build%20%22log%22.txt`,
    });
    // Neither name nor content is logged.
    expect(setup.logged.join("")).not.toContain("checkout.png");
    expect(setup.logged.join("")).not.toContain("alert(1)");

    const missing = await setup.server.inject({
      url: "/api/floors/web-shop/manager-chat/attachments/nothing",
      headers: setup.owner.headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "attachment_not_found" });
  });

  it("refuses a file of another type, one that is not what it says, an empty or too large one", async () => {
    const setup = await setUp();
    for (const [payload, message] of [
      [
        { name: "a.svg", mediaType: "image/svg+xml", content: "PHN2Zz4=" },
        "Attach an image (PNG, JPEG, GIF or WebP) or a text file (such as a log, Markdown, CSV, JSON, XML or YAML).",
      ],
      [
        {
          name: "a.png",
          mediaType: "image/png",
          content: Buffer.from("<svg onload=alert(1)>").toString("base64"),
        },
        "The file is not the PNG image it says it is.",
      ],
      [
        {
          name: "a.log",
          mediaType: "text/plain",
          content: Buffer.alloc(maxChatTextBytes + 1, "a").toString("base64"),
        },
        "A text file is at most 1 MiB.",
      ],
      [
        { name: "a.log", mediaType: "text/plain", content: "" },
        "The file is empty.",
      ],
    ] as const) {
      const refused = await upload(setup, payload);
      expect(refused.statusCode).toBe(400);
      expect(JSON.stringify(refused.json())).toContain(message);
    }
    // An upload needs the CSRF token, like every change.
    const withoutCsrf = Object.fromEntries(
      Object.entries(setup.owner.headers).filter(
        ([name]) => name !== "x-csrf-token",
      ),
    );
    expect(
      (
        await upload(
          setup,
          { name: "a.log", mediaType: "text/plain", content: "YQ==" },
          withoutCsrf,
        )
      ).statusCode,
    ).toBe(403);
  });

  it("sends attachments with a message, once, and lists them with it", async () => {
    const setup = await setUp();
    const log = chatAttachmentSchema.parse(
      (
        await upload(setup, {
          name: "build.log",
          mediaType: "text/plain",
          content: Buffer.from("it broke").toString("base64"),
        })
      ).json(),
    );
    const sent = await setup.server.inject({
      method: "POST",
      url: "/api/floors/web-shop/manager-chat/messages",
      headers: setup.owner.headers,
      payload: { text: "", attachments: [log.id] },
    });
    expect(sent.statusCode).toBe(201);
    expect(
      managerChatSendResponseSchema.parse(sent.json()).message.attachments,
    ).toEqual([log]);
    await expect
      .poll(() => setup.model.requests.at(-1)?.messages.at(-1)?.content)
      .toContain("it broke");
    setup.model.release();
    await expect
      .poll(async () => (await history(setup)).messages.length)
      .toBe(2);
    expect((await history(setup)).messages[0]?.attachments).toEqual([log]);

    const again = await setup.server.inject({
      method: "POST",
      url: "/api/floors/web-shop/manager-chat/messages",
      headers: setup.owner.headers,
      payload: { text: "Again", attachments: [log.id] },
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: "attachment_not_found" });
    // A message of nothing at all is refused.
    expect((await send(setup, "")).statusCode).toBe(400);
  });
});

describe("@ mentions and the task list (FR-24)", () => {
  it("offers the repository's files matching what follows @, read through the GitHub App", async () => {
    const setup = await setUp(memoryStores(), undefined, (github, stores) => ({
      chatFiles: createChatRepositoryFiles({ floors: stores.floors, github }),
    }));
    setup.github.pushCommit("adrianeyre/web-shop", "main", {
      files: {
        "src/checkout/total.ts": "x",
        "src/orders/page.tsx": "y",
        "docs/checkout.md": "z",
      },
    });
    const found = await setup.server.inject({
      url: "/api/floors/web-shop/manager-chat/files?query=CHECKOUT",
      headers: setup.owner.headers,
    });
    expect(found.statusCode).toBe(200);
    expect(managerChatFileListSchema.parse(found.json())).toEqual({
      files: ["docs/checkout.md", "src/checkout/total.ts"],
    });
    expect(
      (
        await setup.server.inject({
          url: "/api/floors/nowhere/manager-chat/files?query=a",
          headers: setup.owner.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await setup.server.inject({
          url: "/api/floors/web-shop/manager-chat/files?query=a&b=c",
          headers: setup.owner.headers,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("answers the chat's tasks, and none without them", async () => {
    const task: ManagerChatTask = {
      id: "issue:12",
      kind: "issue",
      title: "#12 The orders page",
      state: "running",
      messageId: 3,
      batchId: 1,
      issue: 12,
      url: "https://github.com/adrianeyre/web-shop/issues/12",
      agentId: "coder-1",
      agentName: "Ada",
    };
    const setup = await setUp(memoryStores(), undefined, () => ({
      chatTasks: { list: () => Promise.resolve([task]) },
    }));
    const listed = await setup.server.inject({
      url: "/api/floors/web-shop/manager-chat/tasks",
      headers: setup.owner.headers,
    });
    expect(managerChatTaskListSchema.parse(listed.json())).toEqual({
      tasks: [task],
    });
    const plain = await setUp(memoryStores());
    expect(
      (
        await plain.server.inject({
          url: "/api/floors/web-shop/manager-chat/tasks",
          headers: plain.owner.headers,
        })
      ).json(),
    ).toEqual({ tasks: [] });
  });
});

describe("kept in Postgres 18", () => {
  postgresTest(
    "keeps each Floor's chat across a restart",
    async ({ database }) => {
      const first = await setUp(databaseStores(database.db));
      await send(first, "skip 4");
      await send(first, "What next?");
      first.model.release();
      await expect
        .poll(async () => (await history(first)).messages.length)
        .toBe(4);
      await first.server.close();

      const second = await setUp(databaseStores(database.db));
      const chat = await history(second);
      expect(chat.messages.map(({ kind, text }) => [kind, text])).toEqual([
        ["owner", "skip 4"],
        [
          "command",
          "Understood: skip issue #4. Batches are not available here, so nothing changed.",
        ],
        ["owner", "What next?"],
        ["reply", "Start with #4."],
      ]);
    },
  );

  postgresTest(
    "keeps a message's attachments, listed with it and served",
    async ({ database }) => {
      const setup = await setUp(databaseStores(database.db));
      const shot = chatAttachmentSchema.parse(
        (
          await upload(setup, {
            name: "checkout.png",
            mediaType: "image/png",
            content: png.toString("base64"),
          })
        ).json(),
      );
      const sent = await setup.server.inject({
        method: "POST",
        url: "/api/floors/web-shop/manager-chat/messages",
        headers: setup.owner.headers,
        payload: { text: "pause", attachments: [shot.id] },
      });
      expect(sent.statusCode).toBe(201);
      expect((await history(setup)).messages[0]?.attachments).toEqual([shot]);
      const served = await setup.server.inject({
        url: `/api/floors/web-shop/manager-chat/attachments/${shot.id}`,
        headers: setup.owner.headers,
      });
      expect(served.rawPayload).toEqual(png);
    },
  );
});
