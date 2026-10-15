import {
  grillingSessionSummarySchema,
  randomAvatar,
  type Agent,
  type AiAccount,
  type GrillingIssueDraftEdit,
  type GrillingSession,
  type ManagerChat,
  type ManagerChatMessage,
  type ManagerChatTask,
} from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { attachmentProblem, mediaTypeOf } from "./chat-attachments.tsx";
import { mentionAt, withMention } from "./file-mention-autocomplete.tsx";
import { withFrame, withToolFrame } from "./manager-chat.tsx";
import { createAppRouter } from "./router.tsx";

// The Manager chat (PRD FR-24): the conversation so far, commands answered
// at once with what was understood, and the Manager's replies streaming
// in a piece at a time.

const message = (
  id: number,
  kind: ManagerChatMessage["kind"],
  text: string,
  replyTo: number | null = kind === "owner" ? null : id - 1,
): ManagerChatMessage => ({
  id,
  floorId: "web-shop",
  kind,
  text,
  command: kind === "command" ? { kind: "skip", issues: [4] } : null,
  replyTo,
  agentId: kind === "owner" ? null : "mira",
  model: kind === "reply" ? "claude-opus-5-5" : null,
  skill: null,
  grilling: null,
  compaction: null,
  tools: [],
  attachments: [],
  createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0, id)).toISOString(),
});

const chatOf = (
  messages: ManagerChatMessage[],
  pending: ManagerChat["pending"] = [],
): ManagerChat => ({
  manager: {
    id: "mira",
    name: "Mira",
    aiProvider: "Claude",
    model: "claude-opus-5-5",
  },
  messages,
  pending,
});

const floor = {
  id: "web-shop",
  name: "Web shop",
  repository: "adrianeyre/web-shop",
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office" as const,
  defaultBranch: "main",
  setupCommand: "",
  testCommand: "",
  mergePolicy: "send_to_me",
  roundCap: 3,
  tokenCaps: { daily: null, monthly: null },
  concurrencyLimit: null,
  priority: 0,
  requiredReviewerAgentIds: [],
  planApproval: true,
  mostAgents: 8,
  spinOffFromChat: true,
  hourlyStatusUpdates: true,
  freshStartThreshold: 85,
  gitIdentity: null,
  createdAt: "2026-10-08T12:00:00.000Z",
  archivedAt: null,
};

const floorSkills = {
  skills: [
    {
      name: "brand-voice",
      description: "Writes in the shop's voice.",
      source: "repository",
      folder: ".agents/skills/brand-voice",
      overridesOffice: false,
      roles: { coder: true, qa: true, docs: true, designer: true },
    },
    {
      name: "pdf",
      description: "Extract text from PDFs.",
      source: "office",
      folder: null,
      overridesOffice: false,
      roles: { coder: true, qa: true, docs: true, designer: true },
    },
  ],
  ignored: [],
  repositoryError: null,
};

const pdfSkill = {
  name: "pdf",
  description: "Extract text from PDFs.",
  source: "office",
  folder: null,
  overridesOffice: false,
  files: [
    {
      path: "SKILL.md",
      content:
        "---\nname: pdf\ndescription: Extract text from PDFs.\n---\n\n# Extracting text\n\n1. Run **extract.py**.\n",
    },
    { path: "scripts/extract.py", content: "print('every line')\n" },
  ],
};

interface FakeStream extends Omit<EventSourceLike, "readyState"> {
  readyState: number;
  readonly url: string;
  send(data: unknown): void;
}

let streams: FakeStream[];
let posts: { url: string; body: unknown; csrf: string | null }[];
/** Every URL fetched, with its method. */
let fetched: string[];
/** The Floor's Grilling Sessions, as the server gives them. */
let grilling: { sessions: GrillingSession[]; messages: ManagerChatMessage[] };

/** More of the server, which a test may add; undefined falls through. */
let routes: (url: string, init?: RequestInit) => Response | undefined = () =>
  undefined;

/** The server: `chat` so far, and `answer` to each message sent. */
function stubServer(
  chat: ManagerChat,
  answer: (text: string) => Response = () => Response.json({}, { status: 500 }),
  sessions: GrillingSession[] = [],
) {
  posts = [];
  grilling = { sessions, messages: [] };
  fetched = [];
  routes = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      fetched.push(`${init?.method ?? "GET"} ${url}`);
      const routed = routes(url, init);
      if (routed !== undefined) {
        return Promise.resolve(routed);
      }
      if (url === "/api/floors/web-shop/manager-chat/messages") {
        const body = (
          typeof init?.body === "string" ? JSON.parse(init.body) : {}
        ) as { text: string };
        posts.push({
          url,
          body,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
        return Promise.resolve(answer(body.text));
      }
      if (url === "/api/floors/web-shop/manager-chat") {
        return Promise.resolve(Response.json(chat));
      }
      if (url === "/api/floors/web-shop") {
        return Promise.resolve(Response.json(floor));
      }
      if (url === "/api/floors/web-shop/skills") {
        return Promise.resolve(Response.json(floorSkills));
      }
      if (url === "/api/floors/web-shop/skills/pdf") {
        return Promise.resolve(Response.json(pdfSkill));
      }
      if (url === "/api/floors/web-shop/context-usage") {
        return Promise.resolve(
          Response.json({
            agents: [
              {
                agentId: "mira",
                floorId: "web-shop",
                issue: null,
                model: "claude-opus-5-5",
                inputTokens: 84_000,
                contextWindow: 200_000,
                contextUsage: 0.42,
                updatedAt: "2026-10-09T12:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/floors/web-shop/grilling-sessions") {
        return Promise.resolve(
          Response.json({
            sessions: grilling.sessions.map((each) =>
              grillingSessionSummarySchema.parse(each),
            ),
          }),
        );
      }
      const editing =
        /^\/api\/floors\/web-shop\/grilling-sessions\/(\d+)\/issues$/.exec(
          url,
        )?.[1];
      const edited = grilling.sessions.findIndex(
        ({ id }) => String(id) === editing,
      );
      const before = grilling.sessions[edited];
      if (init?.method === "PUT" && before?.issues != null) {
        const body = (
          typeof init.body === "string" ? JSON.parse(init.body) : {}
        ) as { drafts: GrillingIssueDraftEdit[] };
        posts.push({
          url,
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        const after: GrillingSession = {
          ...before,
          issues: {
            ...before.issues,
            drafts: body.drafts.map((draft) => ({ ...draft, filed: null })),
          },
        };
        grilling.sessions[edited] = after;
        return Promise.resolve(Response.json(after));
      }
      const sessionId =
        /^\/api\/floors\/web-shop\/grilling-sessions\/(\d+)$/.exec(url)?.[1];
      const found = grilling.sessions.find(
        ({ id }) => String(id) === sessionId,
      );
      if (found !== undefined) {
        return Promise.resolve(
          Response.json({ session: found, messages: grilling.messages }),
        );
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
}

function renderPage(at = "/floors/web-shop/manager") {
  const history = createMemoryHistory({ initialEntries: [at] });
  render(
    <App
      router={createAppRouter(history)}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  return history;
}

const entries = () =>
  within(screen.getByRole("log", { name: "Manager chat" }))
    .queryAllByRole("listitem")
    .map((item) => [item.dataset["kind"], item.textContent]);

const chatStream = (): FakeStream => {
  const stream = streams.findLast(({ url }) =>
    url.includes("/manager-chat/stream"),
  );
  if (stream === undefined) {
    throw new Error("The chat opened no stream.");
  }
  return stream;
};

describe("the Manager chat", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
    streams = [];
    vi.spyOn(eventSources, "open").mockImplementation((url) => {
      const source: FakeStream = {
        url,
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        close() {
          source.readyState = 2;
        },
        send(data: unknown) {
          source.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(data) }),
          );
        },
      };
      streams.push(source);
      return source;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the Manager and shows the conversation so far", async () => {
    stubServer(
      chatOf([
        message(1, "owner", "skip 4"),
        message(2, "command", "Understood: skip issue #4."),
        message(3, "owner", "skp 4"),
        message(4, "hint", 'Did you mean "skip 4"?'),
        message(5, "owner", "Why?"),
        message(6, "reply", "Because it is blocked."),
        message(7, "owner", "Hello?"),
        message(8, "error", "Mira could not answer: no AI Account."),
      ]),
    );
    renderPage();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Chat with Mira" }),
    ).toBeDefined();
    // The header shows the Manager's Context Usage (FR-87).
    const meter = await screen.findByRole("meter", { name: "Context Usage" });
    expect(meter.getAttribute("aria-valuenow")).toBe("42");
    expect(
      screen.getByText(/The Manager of/).textContent.replaceAll(/\s+/g, " "),
    ).toBe("The Manager of Web shop · Claude claude-opus-5-5");
    await waitFor(() => {
      expect(entries()).toEqual([
        ["owner", "Youskip 4"],
        ["command", "MiraCommandUnderstood: skip issue #4."],
        ["owner", "Youskp 4"],
        ["hint", 'MiraNot understoodDid you mean "skip 4"?'],
        ["owner", "YouWhy?"],
        ["reply", "MiraBecause it is blocked."],
        ["owner", "YouHello?"],
        ["error", "MiraMira could not answer: no AI Account."],
      ]);
    });
    // The stream resumes after the last message read.
    expect(chatStream().url).toBe(
      "/api/floors/web-shop/manager-chat/stream?lastEventId=8",
    );
  });

  it("sends a command, and shows what it was understood as at once", async () => {
    stubServer(chatOf([]), (text) =>
      Response.json(
        {
          message: message(1, "owner", text),
          reply: message(2, "command", "Understood: skip issue #4."),
        },
        { status: 201 },
      ),
    );
    renderPage();
    const box = await screen.findByLabelText("Message Mira");
    await screen.findByText("Nothing yet. Write to Mira below.");
    await userEvent.type(box, "skip 4{Enter}");
    await waitFor(() => {
      expect(entries()).toEqual([
        ["owner", "Youskip 4"],
        ["command", "MiraCommandUnderstood: skip issue #4."],
      ]);
    });
    expect(posts).toEqual([
      {
        url: "/api/floors/web-shop/manager-chat/messages",
        body: { text: "skip 4", attachments: [] },
        csrf: "csrf",
      },
    ]);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("streams the Manager's reply in, a piece at a time", async () => {
    stubServer(chatOf([]), (text) =>
      Response.json(
        { message: message(1, "owner", text), reply: null },
        { status: 201 },
      ),
    );
    renderPage();
    const box = await screen.findByLabelText("Message Mira");
    await userEvent.type(box, "What first?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    // Waiting for the reply: sending now would interrupt it (ADR 0004).
    await waitFor(() => {
      expect(entries()).toEqual([
        ["owner", "YouWhat first?"],
        ["pending", "Mira is thinking…"],
      ]);
    });
    expect(screen.getByRole("status", { name: "Connection" }).textContent).toBe(
      "Mira is answering…",
    );
    await userEvent.type(box, "pause");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Interrupt and send",
      }).disabled,
    ).toBe(false);

    const stream = chatStream();
    act(() => {
      stream.onopen?.(new Event("open"));
      stream.send({
        type: "message",
        message: message(1, "owner", "What first?"),
      });
      stream.send({ type: "delta", replyTo: 1, text: "Start " });
    });
    await waitFor(() => {
      expect(entries().at(-1)).toEqual(["pending", "Mira is writing…Start  ▍"]);
    });
    act(() => {
      stream.send({ type: "delta", replyTo: 1, text: "with #4." });
    });
    await waitFor(() => {
      expect(entries().at(-1)).toEqual([
        "pending",
        "Mira is writing…Start with #4. ▍",
      ]);
    });
    act(() => {
      stream.send({
        type: "message",
        message: message(2, "reply", "Start with #4."),
      });
      // A late piece of a reply already kept changes nothing.
      stream.send({ type: "delta", replyTo: 1, text: " (late)" });
    });
    await waitFor(() => {
      expect(entries()).toEqual([
        ["owner", "YouWhat first?"],
        ["reply", "MiraStart with #4."],
      ]);
    });
    expect(screen.getByRole("status", { name: "Connection" }).textContent).toBe(
      "Live",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled,
    ).toBe(false);
  });

  it("lists the Floor's Available Skills beside the chat, and running one puts /name in the box", async () => {
    const user = userEvent.setup();
    stubServer(chatOf([]));
    renderPage();
    const skills = within(
      await screen.findByRole("complementary", { name: "Available Skills" }),
    );
    const list = await skills.findByRole("list", { name: "Available Skills" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "brand-voiceRepositoryWrites in the shop's voice.",
      "pdfOfficeExtract text from PDFs.",
    ]);
    // What the Owner had written becomes the Skill's arguments.
    const box = screen.getByLabelText<HTMLTextAreaElement>("Message Mira");
    await user.type(box, "the invoice");

    await user.click(skills.getByRole("button", { name: "Open pdf" }));
    const modal = within(await screen.findByRole("dialog", { name: "pdf" }));
    // SKILL.md, rendered: its heading and list, without its frontmatter.
    expect(
      (await modal.findByRole("heading", { name: "Extracting text" })).tagName,
    ).toBe("H3");
    expect(modal.getByText("extract.py").tagName).toBe("STRONG");
    expect(modal.queryByText(/description: Extract/)).toBeNull();
    // A supporting file, as written.
    await user.click(modal.getByRole("button", { name: "scripts/extract.py" }));
    expect(modal.getByLabelText("scripts/extract.py").textContent).toBe(
      "print('every line')\n",
    );

    await user.click(modal.getByRole("button", { name: "Run /pdf" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(box.value).toBe("/pdf the invoice");
    await waitFor(() => {
      expect(document.activeElement).toBe(box);
    });
    // Running another replaces the command, keeping the arguments.
    await user.click(skills.getByRole("button", { name: "Open pdf" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "pdf" })).getByRole(
        "button",
        { name: "Run /pdf" },
      ),
    );
    expect(box.value).toBe("/pdf the invoice");
  });

  it("puts the Skill the address names in the box, as running one from elsewhere asks", async () => {
    stubServer(chatOf([]));
    const history = renderPage("/floors/web-shop/manager?skill=pdf");
    const box =
      await screen.findByLabelText<HTMLTextAreaElement>("Message Mira");
    await waitFor(() => {
      expect(box.value).toBe("/pdf ");
    });
    // Taken from the address, so a reload does not put it there again.
    await waitFor(() => {
      expect(history.location.search).toBe("");
    });
  });

  it("autocompletes /skill-name from the Floor's Skills", async () => {
    const user = userEvent.setup();
    stubServer(chatOf([]), (text) =>
      Response.json(
        { message: message(1, "owner", text), reply: null },
        { status: 201 },
      ),
    );
    renderPage();
    const box =
      await screen.findByLabelText<HTMLTextAreaElement>("Message Mira");
    await screen.findByRole("listitem", { name: "pdf" });
    const options = () =>
      within(screen.getByRole("listbox", { name: "Skills to run" }))
        .getAllByRole("option")
        .map((option) => [
          option.textContent,
          option.getAttribute("aria-selected"),
        ]);

    await user.type(box, "/");
    expect(options()).toEqual([
      ["/brand-voice Writes in the shop's voice.", "true"],
      ["/pdf Extract text from PDFs.", "false"],
    ]);
    expect(box.getAttribute("aria-controls")).toBe(
      screen.getByRole("listbox").id,
    );
    await user.keyboard("{ArrowDown}");
    expect(options().map(([, selected]) => selected)).toEqual([
      "false",
      "true",
    ]);
    expect(box.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[1]?.id,
    );
    // Enter puts the one chosen in the box, and sends nothing.
    await user.keyboard("{Enter}");
    expect(box.value).toBe("/pdf ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(posts).toEqual([]);

    // Narrowed by what is typed; Tab takes it too.
    await user.clear(box);
    await user.type(box, "/br");
    expect(options()).toEqual([
      ["/brand-voice Writes in the shop's voice.", "true"],
    ]);
    await user.keyboard("{Tab}");
    expect(box.value).toBe("/brand-voice ");
    expect(document.activeElement).toBe(box);

    // A click takes one.
    await user.clear(box);
    await user.type(box, "/d");
    await user.click(screen.getByRole("option", { name: /\/pdf/ }));
    expect(box.value).toBe("/pdf ");

    // Escape closes it, and Enter then sends what was written.
    await user.clear(box);
    await user.type(box, "/pd");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        { text: "/pd", attachments: [] },
      ]);
    });
  });

  it("marks the Owner's message that ran a Skill, and the reply whose Skill the Manager chose", async () => {
    stubServer(
      chatOf([
        {
          ...message(1, "owner", "/pdf invoice.pdf"),
          skill: {
            name: "pdf",
            source: "office",
            arguments: "invoice.pdf",
            chosenBy: "owner",
          },
        },
        message(2, "reply", "Page 1: Invoice."),
        message(3, "owner", "And the receipt?"),
        {
          ...message(4, "reply", "Using the Skill /pdf.\n\nPage 1: Receipt."),
          skill: {
            name: "pdf",
            source: "office",
            arguments: null,
            chosenBy: "manager",
          },
        },
      ]),
    );
    renderPage();
    await waitFor(() => {
      expect(entries()).toEqual([
        ["owner", "Skill /pdfYou/pdf invoice.pdf"],
        ["reply", "MiraPage 1: Invoice."],
        ["owner", "YouAnd the receipt?"],
        ["reply", "MiraSkill /pdfUsing the Skill /pdf.\n\nPage 1: Receipt."],
      ]);
    });
  });

  it("shows where the conversation was cleared and compacted (FR-87)", async () => {
    stubServer(
      chatOf([
        message(1, "owner", "/clear"),
        message(
          2,
          "clear",
          "Cleared the conversation: Mira starts afresh from here. Decisions, Plans and Batches are kept.",
        ),
        message(3, "owner", "What next?"),
        {
          ...message(4, "summary", "The Owner wants the basket first."),
          replyTo: null,
          compaction: {
            trigger: "auto",
            contextUsage: 0.873,
            upTo: 3,
            messages: 2,
          },
        },
        message(5, "reply", "The basket."),
      ]),
    );
    renderPage();
    const cleared = await screen.findByRole("separator", {
      name: "Conversation cleared",
    });
    expect(cleared.textContent).toBe(
      "Cleared the conversation: Mira starts afresh from here. Decisions, Plans and Batches are kept.",
    );
    const summary = screen.getByText("The Owner wants the basket first.");
    expect(summary.closest("details")).not.toBeNull();
    expect(
      screen.getByText(/Automatically, at 87% Context Usage/).textContent,
    ).toContain(
      "Automatically, at 87% Context Usage: 2 earlier messages replaced by Mira's summary.",
    );
    // The hint names both commands.
    expect(
      screen.getByText(/clears the conversation and/).textContent,
    ).toContain("/compact replaces it with a summary");
  });

  it("shows a chat request's Plan and the Manager's progress on it (FR-24, ADR 0004)", async () => {
    stubServer(
      chatOf([
        message(1, "owner", "Add a status column to orders, and show it."),
        message(
          2,
          "plan",
          "I'm filing 2 issues and starting them now as one Batch.",
        ),
        message(3, "progress", "Migration writer arrived.", 1),
        message(4, "progress", "#12 is done: pull request #34 was merged.", 1),
      ]),
    );
    renderPage();
    const plan = await screen.findByText(
      "I'm filing 2 issues and starting them now as one Batch.",
    );
    const planMessage = plan.parentElement ?? fail();
    expect(within(planMessage).getByText("Plan")).toBeTruthy();
    const progress = screen.getByText(
      "#12 is done: pull request #34 was merged.",
    );
    expect(
      within(progress.parentElement ?? fail()).getByText("Progress"),
    ).toBeTruthy();
    expect(screen.getAllByText("Progress")).toHaveLength(2);
    // Lighter than a reply: outlined, not filled.
    expect(progress.className).toContain("border");
    expect(progress.className).not.toContain("bg-muted");
  });

  it("says why a message was refused", async () => {
    stubServer(chatOf([]), () =>
      Response.json(
        {
          error: "floor_archived",
          message: 'The Floor "Web shop" is archived.',
        },
        { status: 409 },
      ),
    );
    renderPage();
    await userEvent.type(await screen.findByLabelText("Message Mira"), "pause");
    await screen.findByText("Nothing yet. Write to Mira below.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      'The Floor "Web shop" is archived.',
    );
  });
});

describe("Grilling Sessions in the Manager chat", () => {
  const question = (
    number: number,
    text: string,
    recommended: string,
    status: "open" | "answered" = "open",
  ) => ({
    number,
    round: 1,
    text,
    recommended,
    dependsOn: [],
    status,
    answer: status === "answered" ? recommended : null,
    acceptedRecommended: status === "answered",
    answeredAt: status === "answered" ? "2026-10-10T12:00:01.000Z" : null,
  });
  const session = (
    id: number,
    status: GrillingSession["status"],
    questions: GrillingSession["questions"],
  ): GrillingSession => ({
    id,
    floorId: "web-shop",
    topic: id === 1 ? "exports" : "returns",
    skill: "grilling",
    status,
    round: 1,
    awaitingConfirmation: false,
    openQuestions: questions.filter((each) => each.status === "open").length,
    decisionCount: status === "paused" ? 1 : 0,
    startedAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:01.000Z",
    pausedAt: status === "paused" ? "2026-10-10T12:00:02.000Z" : null,
    endedAt: null,
    questions,
    decisions: [],
    terms: [],
    facts: [],
    outline: [],
    adrs: [],
    processes: [],
    documents: null,
    issues: null,
    sources: [],
  });
  const roundMessage = (): ManagerChatMessage => ({
    ...message(
      2,
      "reply",
      "Let's settle the export.\n\nRound 1: 3 questions.\n\n1. CSV or JSON?\n   Recommended: CSV.",
    ),
    grilling: { sessionId: 1, round: 1 },
  });

  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
    streams = [];
    vi.spyOn(eventSources, "open").mockImplementation((url) => {
      const source: FakeStream = {
        url,
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        close() {
          source.readyState = 2;
        },
        send() {
          return undefined;
        },
      };
      streams.push(source);
      return source;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a round's questions as cards, each with an answer box and an accept-recommended button, and sends the answers as one message", async () => {
    const running = session(1, "active", [
      question(1, "CSV or JSON?", "CSV."),
      question(2, "Who may export?", "Only the Owner."),
      question(3, "How often?", "Weekly."),
    ]);
    stubServer(
      chatOf([
        {
          ...message(1, "owner", "/grilling exports"),
          grilling: { sessionId: 1, round: null },
        },
        roundMessage(),
      ]),
      (text) =>
        Response.json(
          {
            message: {
              ...message(3, "owner", text),
              grilling: { sessionId: 1, round: null },
            },
            reply: null,
          },
          { status: 201 },
        ),
      [running],
    );
    renderPage();
    const cards = await screen.findByRole("list", {
      name: "Round 1 questions",
    });
    // The round's text shows only its preamble; its questions are cards.
    expect(screen.getByText("Let's settle the export.").textContent).toBe(
      "Let's settle the export.",
    );
    const first = within(cards).getByRole("listitem", {
      name: "1. CSV or JSON?",
    });
    expect(first.textContent).toContain("Recommended: CSV.");
    expect(
      within(cards).getAllByRole("button", { name: "Accept recommended" }),
    ).toHaveLength(3);

    await userEvent.type(
      within(first).getByLabelText("Your answer to question 1"),
      "JSON, and CSV later",
    );
    const second = within(cards).getByRole("listitem", {
      name: "2. Who may export?",
    });
    const accept = within(second).getByRole("button", {
      name: "Accept recommended",
    });
    await userEvent.click(accept);
    expect(accept.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        { text: "1: JSON, and CSV later\n2: recommended", attachments: [] },
      ]);
    });
  });

  it("accepts the rest of a round with 'Recommended to all'", async () => {
    stubServer(
      chatOf([roundMessage()]),
      (text) =>
        Response.json(
          { message: message(3, "owner", text), reply: null },
          { status: 201 },
        ),
      [
        session(1, "active", [
          question(1, "CSV or JSON?", "CSV.", "answered"),
          question(2, "Who may export?", "Only the Owner."),
        ]),
      ],
    );
    renderPage();
    const cards = await screen.findByRole("list", {
      name: "Round 1 questions",
    });
    // An answered question shows its answer, and takes no more.
    const answered = within(cards).getByRole("listitem", {
      name: "1. CSV or JSON?",
    });
    expect(answered.textContent).toContain("Answered: Recommended");
    expect(within(answered).queryByRole("textbox")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Recommended to all" }),
    );
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        { text: "recommended to all", attachments: [] },
      ]);
    });
  });

  it("pauses the running session, resumes a paused one, and reads one in full, with the facts found and its documents", async () => {
    const paused = {
      ...session(2, "paused", [question(4, "Refunds too?", "Yes.")]),
      skill: "wayfinder" as const,
      decisions: [
        {
          number: 1,
          text: "Returns are free within 30 days.",
          questions: [3],
          round: 1,
          settledAt: "2026-10-10T12:00:01.000Z",
        },
      ],
      facts: [
        {
          number: 1,
          question: "How are returns recorded today?",
          answer: "As refunds on the order, in src/orders/refunds.ts.",
          status: "found" as const,
          agentId: "ada",
          round: 0,
          foundAt: "2026-10-10T12:00:00.500Z",
        },
        {
          number: 2,
          question: "Which carrier collects returns?",
          answer: "Ada finished without an answer.",
          status: "failed" as const,
          agentId: "ada",
          round: 0,
          foundAt: "2026-10-10T12:00:00.500Z",
        },
      ],
      outline: [{ heading: "Problem", text: "Returns are posted by hand." }],
      adrs: [
        {
          title: "Refunds go back to the card",
          decision: "A refund is paid to the card that paid.",
          options: [],
          consequences: [],
          hardToReverse: "Payments are settled.",
          surprising: "Shops often give credit.",
          tradeOff: "Trust over cash flow.",
        },
      ],
      processes: [{ title: "Handling a return", text: "Check the parcel." }],
      documents: {
        branch: "ai-office/grilling-2",
        files: ["GLOSSARY.md"],
        commit: "0123456789abcdef0123456789abcdef01234567",
        writtenAt: "2026-10-10T12:00:01.000Z",
        pullRequest: {
          number: 21,
          url: "https://github.com/adrianeyre/web-shop/pull/21",
        },
        problem: null,
      },
    };
    stubServer(
      chatOf([]),
      (text) =>
        Response.json(
          { message: message(1, "owner", text), reply: null },
          { status: 201 },
        ),
      [paused],
    );
    renderPage();
    const sessions = await screen.findByRole("button", {
      name: "Resume Grilling Session 2: returns",
    });
    await userEvent.click(sessions);
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        { text: "resume session 2", attachments: [] },
      ]);
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Read Grilling Session 2: returns" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Grilling Session 2: returns",
    });
    await within(dialog).findByText("Returns are free within 30 days.");
    expect(
      within(dialog).getByRole("listitem", {
        name: "F1. How are returns recorded today?",
      }).textContent,
    ).toContain("As refunds on the order, in src/orders/refunds.ts.");
    expect(
      within(dialog).getByRole("listitem", {
        name: "F2. Which carrier collects returns?",
      }).textContent,
    ).toContain("Not found: Ada finished without an answer.");
    expect(
      within(dialog).getByRole("listitem", { name: "4. Refunds too?" })
        .textContent,
    ).toContain("Recommended: Yes.");
    // The Skill that started it, there and in the list (FR-83b).
    expect(dialog.textContent).toContain("Started with /wayfinder");
    expect(
      screen
        .getByRole("button", { name: "Read Grilling Session 2: returns" })
        .closest("li")?.textContent,
    ).toContain("/wayfinder · 1 round");
    // Its documents: where they are kept, their pull request, its outline,
    // ADRs and process docs (FR-80).
    expect(dialog.textContent).toContain(
      "Kept on ai-office/grilling-2: GLOSSARY.md.",
    );
    expect(
      within(dialog)
        .getByRole("link", { name: "Pull request #21" })
        .getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/pull/21");
    expect(
      within(dialog).getByText("Returns are posted by hand."),
    ).toBeTruthy();
    expect(dialog.textContent).toContain(
      "Refunds go back to the card: A refund is paid to the card that paid.",
    );
    expect(within(dialog).getByText("Handling a return")).toBeTruthy();
  });

  it("edits, reorders, merges and drops an ended session's draft issues, then approves them to be filed", async () => {
    const draft = (
      id: number,
      title: string,
      blockedBy: number[] = [],
    ): NonNullable<GrillingSession["issues"]>["drafts"][number] => ({
      id,
      title,
      whatToBuild: `Build ${title.toLowerCase()}.`,
      acceptanceCriteria: [`${title} works`],
      blockedBy,
      prdSections: id === 2 ? ["Requirements"] : [],
      adrs: [],
      filed: null,
    });
    const ended: GrillingSession = {
      ...session(1, "ended", []),
      endedAt: "2026-10-10T12:00:03.000Z",
      issues: {
        drafts: [
          draft(1, "Export button"),
          draft(2, "Build the CSV", [1]),
          draft(3, "Name the columns", [2]),
          draft(4, "Schedule exports", [1]),
        ],
        draftedAt: "2026-10-10T12:00:04.000Z",
        approvedAt: null,
        problem: null,
      },
    };
    stubServer(
      chatOf([]),
      (text) =>
        Response.json(
          { message: message(1, "owner", text), reply: null },
          { status: 201 },
        ),
      [ended],
    );
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Read Grilling Session 1: exports",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Grilling Session 1: exports",
    });
    const list = await within(dialog).findByRole("list", {
      name: "The draft issues, in order",
    });
    const names = () =>
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label"));
    expect(names()).toEqual([
      "Issue 1: Export button",
      "Issue 2: Build the CSV",
      "Issue 3: Name the columns",
      "Issue 4: Schedule exports",
    ]);
    expect(dialog.textContent).toContain("Cites the PRD's § Requirements.");

    // Blocked by each other: it cannot be approved until undone.
    const cycle = within(dialog).getByRole("checkbox", {
      name: "Issue 1: Export button is blocked by Issue 3: Name the columns",
    });
    await userEvent.click(cycle);
    expect(within(dialog).getByRole("status").textContent).toBe(
      "Some issues are blocked by each other in a cycle, so none could be filed first.",
    );
    const approve = () =>
      within(dialog).getByRole("button", { name: /^Approve and file/ });
    expect(approve()).toHaveProperty("disabled", true);
    await userEvent.click(cycle);

    // Edited, merged, dropped and moved.
    const title = within(dialog).getByLabelText("Title", {
      selector: "#issue-1-1-title",
    });
    await userEvent.clear(title);
    await userEvent.type(title, "Add the Export button");
    const criteria = within(dialog).getByLabelText(
      "Acceptance criteria, one per line",
      { selector: "#issue-1-1-criteria" },
    );
    await userEvent.type(criteria, "{Enter}It is reachable from the keyboard");
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Merge it into", {
        selector: "#issue-1-3-merge",
      }),
      "Issue 2: Build the CSV",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Drop issue 3" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Move issue 2 up" }),
    );
    expect(names()).toEqual([
      "Issue 1: Build the CSV",
      "Issue 2: Add the Export button",
    ]);
    expect(approve().textContent).toBe("Approve and file 2 issues");

    await userEvent.click(approve());
    await waitFor(() => {
      expect(posts).toHaveLength(2);
    });
    expect(posts[0]).toEqual({
      url: "/api/floors/web-shop/grilling-sessions/1/issues",
      csrf: "csrf",
      body: {
        drafts: [
          {
            id: 2,
            title: "Build the CSV",
            whatToBuild: "Build build the csv.\n\nBuild name the columns.",
            acceptanceCriteria: [
              "Build the CSV works",
              "Name the columns works",
            ],
            blockedBy: [1],
            prdSections: ["Requirements"],
            adrs: [],
          },
          {
            id: 1,
            title: "Add the Export button",
            whatToBuild: "Build export button.",
            acceptanceCriteria: [
              "Export button works",
              "It is reachable from the keyboard",
            ],
            blockedBy: [],
            prdSections: [],
            adrs: [],
          },
        ],
      },
    });
    // Then approved in the chat, which has them filed.
    expect(posts[1]?.body).toEqual({
      text: "file the issues of session 1",
      attachments: [],
    });
  });

  it("links an ended session's filed issues, and files the rest after a failure", async () => {
    const ended: GrillingSession = {
      ...session(1, "ended", []),
      endedAt: "2026-10-10T12:00:03.000Z",
      issues: {
        drafts: [
          {
            id: 1,
            title: "Export button",
            whatToBuild: "A button.",
            acceptanceCriteria: ["It downloads"],
            blockedBy: [],
            prdSections: [],
            adrs: [],
            filed: {
              number: 12,
              url: "https://github.com/adrianeyre/web-shop/issues/12",
            },
          },
          {
            id: 2,
            title: "Build the CSV",
            whatToBuild: "The rows.",
            acceptanceCriteria: ["Every order is a row"],
            blockedBy: [1],
            prdSections: [],
            adrs: [],
            filed: null,
          },
        ],
        draftedAt: "2026-10-10T12:00:04.000Z",
        approvedAt: "2026-10-10T12:00:05.000Z",
        problem: "GitHub is unavailable.",
      },
    };
    stubServer(
      chatOf([]),
      (text) =>
        Response.json(
          { message: message(1, "owner", text), reply: null },
          { status: 201 },
        ),
      [ended],
    );
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Read Grilling Session 1: exports",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Grilling Session 1: exports",
    });
    expect(
      (await within(dialog).findByRole("link", { name: "#12" })).getAttribute(
        "href",
      ),
    ).toBe("https://github.com/adrianeyre/web-shop/issues/12");
    expect(dialog.textContent).toContain("Not filed yet: Build the CSV");
    expect(dialog.textContent).toContain(
      "Filing stopped: GitHub is unavailable.",
    );
    expect(within(dialog).queryByRole("textbox", { name: "Title" })).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "File the rest" }),
    );
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        { text: "file the issues of session 1", attachments: [] },
      ]);
    });
  });

  it("shows the running session above the chat, to pause or confirm", async () => {
    let id = 0;
    stubServer(
      chatOf([]),
      (text) =>
        Response.json(
          {
            message: message(++id, "owner", text),
            reply: { ...message(++id, "grilling", "Done."), replyTo: id - 1 },
          },
          { status: 201 },
        ),
      [{ ...session(1, "active", []), awaitingConfirmation: true }],
    );
    renderPage();
    const bar = await screen.findByRole("region", {
      name: "Grilling Session",
    });
    expect(bar.textContent).toContain("Grilling Session 1: exports");
    expect(bar.textContent).toContain("Round 1 · 0 open · 0 decisions");
    await userEvent.click(
      within(bar).getByRole("button", { name: "Confirm and end" }),
    );
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        { text: "confirm", attachments: [] },
      ]);
    });
    await userEvent.click(
      within(bar).getByRole("button", { name: "Pause session" }),
    );
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        { text: "confirm", attachments: [] },
        { text: "pause the session", attachments: [] },
      ]);
    });
  });

  it("ends the running session with End session, once the Owner says yes (FR-83a)", async () => {
    let id = 0;
    stubServer(
      chatOf([]),
      (text) =>
        Response.json(
          {
            message: message(++id, "owner", text),
            reply: { ...message(++id, "grilling", "Ended."), replyTo: id - 1 },
          },
          { status: 201 },
        ),
      [{ ...session(1, "active", []), openQuestions: 2 }],
    );
    renderPage();
    const bar = await screen.findByRole("region", {
      name: "Grilling Session",
    });
    // Asked first, saying what ending does; Cancel sends nothing.
    await userEvent.click(
      within(bar).getByRole("button", { name: "End session" }),
    );
    const asking = screen.getByRole("region", { name: "Grilling Session" });
    expect(asking.textContent).toContain(
      "End the Grilling Session 1: exports now? 2 questions are left open; what has settled is kept, its documents' pull request opens, and everyone walks back to their desk.",
    );
    await userEvent.click(
      within(asking).getByRole("button", { name: "Cancel" }),
    );
    expect(posts).toEqual([]);

    await userEvent.click(
      within(
        screen.getByRole("region", { name: "Grilling Session" }),
      ).getByRole("button", { name: "End session" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, end the session" }),
    );
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        { text: "end the session", attachments: [] },
      ]);
    });
  });
});

describe("the Manager chat as an agent session (FR-24, ADR 0004)", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
    streams = [];
    vi.spyOn(eventSources, "open").mockImplementation((url) => {
      const source: FakeStream = {
        url,
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        close() {
          source.readyState = 2;
        },
        send(data: unknown) {
          source.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(data) }),
          );
        },
      };
      streams.push(source);
      return source;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const task = (
    id: string,
    change: Partial<ManagerChatTask> = {},
  ): ManagerChatTask => ({
    id,
    kind: "issue",
    title: "Add a status column",
    state: "running",
    messageId: 1,
    batchId: 7,
    issue: 12,
    url: "https://github.com/adrianeyre/web-shop/issues/12",
    agentId: "rex",
    agentName: "Rex",
    ...change,
  });

  const tasksFetched = () =>
    fetched.filter(
      (each) => each === "GET /api/floors/web-shop/manager-chat/tasks",
    ).length;

  it("lists the tasks a request spun off, each opening its Agent's live view, and fetches them again as they change", async () => {
    stubServer(chatOf([message(1, "owner", "Add a status column.")]));
    let tasks: ManagerChatTask[] = [
      task("issue:12"),
      task("contractor:mig", {
        kind: "contractor",
        title: "Write the migration",
        state: "queued",
        issue: null,
        url: null,
        agentId: "mig",
        agentName: "Migration writer",
      }),
    ];
    routes = (url) =>
      url === "/api/floors/web-shop/manager-chat/tasks"
        ? Response.json({ tasks })
        : undefined;
    renderPage();
    const list = await screen.findByRole("list", {
      name: "Tasks the Manager spun off",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "RunningIssue: Add a status column#12Rex",
      "QueuedContractor: Write the migrationMigration writer",
    ]);
    expect(
      within(items[0] ?? fail())
        .getByRole("link", { name: "Issue #12 on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/issues/12");
    expect(
      within(items[0] ?? fail())
        .getByRole("link", { name: "Watch Rex work on “Add a status column”" })
        .getAttribute("href"),
    ).toBe("/floors/web-shop/agents/rex");
    expect(
      within(items[1] ?? fail())
        .getByRole("link", { name: /Migration writer/ })
        .getAttribute("href"),
    ).toBe("/floors/web-shop/agents/mig");

    // It folds away.
    const toggle = screen.getByRole("button", { name: /^Tasks/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("2 of 2 still going");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("list", { name: "Tasks the Manager spun off" }),
    ).toBeNull();
    await userEvent.click(toggle);

    // A `tasks` frame says the list changed; so may a new message.
    const before = tasksFetched();
    tasks = [task("issue:12", { state: "done" }), ...tasks.slice(1)];
    act(() => {
      chatStream().send({ type: "tasks" });
    });
    await waitFor(() => {
      expect(toggle.textContent).toContain("1 of 2 still going");
    });
    expect(tasksFetched()).toBe(before + 1);
    act(() => {
      chatStream().send({
        type: "message",
        message: message(2, "progress", "#12 is done.", 1),
      });
    });
    await waitFor(() => {
      expect(tasksFetched()).toBe(before + 2);
    });
  });

  it("sends while the Manager is writing, which interrupts it, and says when a request is being carried out", async () => {
    let refuse = false;
    stubServer(
      chatOf(
        [message(1, "owner", "Plan the refunds.")],
        [{ replyTo: 1, text: "Let me" }],
      ),
      (text) =>
        refuse
          ? Response.json(
              {
                error: "reply_in_progress",
                message:
                  "Mira is carrying out your last request: send this once it has.",
              },
              { status: 409 },
            )
          : Response.json(
              { message: message(3, "owner", text), reply: null },
              { status: 201 },
            ),
    );
    renderPage();
    const box = await screen.findByLabelText("Message Mira");
    await waitFor(() => {
      expect(entries().at(-1)).toEqual(["pending", "Mira is writing…Let me ▍"]);
    });
    // The box stays open while Mira writes.
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    await userEvent.type(box, "Actually, only card refunds.");
    await userEvent.click(
      screen.getByRole("button", { name: "Interrupt and send" }),
    );
    await waitFor(() => {
      expect(entries()).toEqual([
        ["owner", "YouPlan the refunds."],
        ["owner", "YouActually, only card refunds."],
        ["pending", "Mira is thinking…"],
      ]);
    });
    expect(posts.map(({ body }) => body)).toEqual([
      { text: "Actually, only card refunds.", attachments: [] },
    ]);

    refuse = true;
    await userEvent.type(box, "And PayPal?{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Mira is carrying out your last request: send this once it has.",
    );
    expect((box as HTMLTextAreaElement).value).toBe("And PayPal?");
  });

  it("checks, uploads, removes and sends attachments, and shows those of sent messages", async () => {
    const user = userEvent.setup({ applyAccept: false });
    let uploaded = 0;
    stubServer(
      chatOf([
        {
          ...message(1, "owner", "Here is the error."),
          attachments: [
            {
              id: "att-1",
              name: "checkout.png",
              mediaType: "image/png",
              size: 2048,
            },
            {
              id: "att-2",
              name: "server.log",
              mediaType: "text/plain",
              size: 300,
            },
          ],
        },
      ]),
      (text) =>
        Response.json(
          { message: message(2, "owner", text), reply: null },
          { status: 201 },
        ),
    );
    const uploads: unknown[] = [];
    routes = (url, init) => {
      if (
        url === "/api/floors/web-shop/manager-chat/attachments" &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(
          typeof init.body === "string" ? init.body : "{}",
        ) as {
          name: string;
          mediaType: string;
        };
        uploads.push(body);
        uploaded += 1;
        return Response.json(
          {
            id: `new-${String(uploaded)}`,
            name: body.name,
            mediaType: body.mediaType,
            size: 5,
          },
          { status: 201 },
        );
      }
      return undefined;
    };
    renderPage();

    // A sent message's image is a thumbnail, its text file a chip, each
    // opening its content.
    const sent = await screen.findByRole("list", { name: "Attachments" });
    expect(
      within(sent)
        .getByRole("img", { name: "checkout.png" })
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/api/floors/web-shop/manager-chat/attachments/att-1");
    expect(
      within(sent)
        .getByRole("link", { name: /server\.log/ })
        .getAttribute("href"),
    ).toBe("/api/floors/web-shop/manager-chat/attachments/att-2");

    const picker = screen.getByLabelText("Files to attach");
    const tooBig = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(tooBig, "size", { value: 6 * 1024 * 1024 });
    await user.upload(picker, [
      new File(["%PDF"], "invoice.pdf", { type: "application/pdf" }),
      tooBig,
      new File(["hello"], "notes.md", { type: "" }),
    ]);
    const problems = await screen.findByRole("alert");
    expect(
      within(problems)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "invoice.pdf cannot be attached: attach an image (PNG, JPEG, GIF or WebP) or a text file (such as a log, Markdown, CSV, JSON, XML or YAML).",
      "huge.png is too large: an image is at most 5 MiB.",
    ]);
    const attached = screen.getByRole("list", { name: "Attached files" });
    await waitFor(() => {
      expect(within(attached).getByRole("listitem").textContent).toBe(
        "notes.md5 bytes",
      );
    });
    expect(uploads).toEqual([
      { name: "notes.md", mediaType: "text/markdown", content: "aGVsbG8=" },
    ]);

    // Pasted onto the box, then taken off again.
    const box = screen.getByLabelText("Message Mira");
    fireEvent.paste(box, {
      clipboardData: {
        files: [new File(["png"], "shot.png", { type: "image/png" })],
      },
    });
    await waitFor(() => {
      expect(within(attached).getAllByRole("listitem")).toHaveLength(2);
    });
    await user.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(within(attached).getAllByRole("listitem")).toHaveLength(1);

    // At most five to a message.
    await user.upload(
      picker,
      ["a", "b", "c", "d", "e"].map(
        (name) => new File(["x"], `${name}.txt`, { type: "text/plain" }),
      ),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "e.txt was not attached: a message carries at most 5 files.",
    );
    await waitFor(() => {
      expect(within(attached).getAllByRole("listitem")).toHaveLength(5);
    });

    // With no words, the files alone send.
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Send" })
          .disabled,
      ).toBe(false);
    });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(posts.map(({ body }) => body)).toEqual([
        {
          text: "",
          attachments: ["new-1", "new-3", "new-4", "new-5", "new-6"],
        },
      ]);
    });
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("shows the tools a reply used, collapsed, and those of a reply being written as they come", async () => {
    const user = userEvent.setup();
    stubServer(
      chatOf(
        [
          message(1, "owner", "Where is the total worked out?"),
          {
            ...message(2, "reply", "In src/checkout/total.ts."),
            tools: [
              { name: "Grep", summary: '"total" in src/' },
              { name: "Read", summary: "src/checkout/total.ts" },
            ],
          },
          message(3, "owner", "And tax?"),
        ],
        [{ replyTo: 3, text: "" }],
      ),
    );
    renderPage();
    const used = await screen.findByText("Used 2 tools");
    const disclosure = used.closest("details") ?? fail();
    expect(disclosure.open).toBe(false);
    await user.click(used);
    expect(disclosure.open).toBe(true);
    expect(
      within(disclosure)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(['Grep "total" in src/', "Read src/checkout/total.ts"]);

    const stream = chatStream();
    act(() => {
      stream.send({
        type: "tool",
        replyTo: 3,
        tool: { name: "Glob", summary: "src/**/tax*.ts" },
      });
    });
    const live = await screen.findByText("Using 1 tool");
    expect(live.closest("li")?.dataset["kind"]).toBe("pending");
    act(() => {
      stream.send({
        type: "tool",
        replyTo: 3,
        tool: { name: "Read", summary: "src/checkout/tax.ts" },
      });
    });
    await screen.findByText("Using 2 tools");
    act(() => {
      stream.send({
        type: "message",
        message: {
          ...message(4, "reply", "In src/checkout/tax.ts."),
          tools: [
            { name: "Glob", summary: "src/**/tax*.ts" },
            { name: "Read", summary: "src/checkout/tax.ts" },
          ],
        },
      });
    });
    await waitFor(() => {
      expect(screen.getAllByText("Used 2 tools")).toHaveLength(2);
    });
    expect(screen.queryByText(/^Using/)).toBeNull();
  });

  it("mentions the repository's files with @, from the keyboard", async () => {
    const user = userEvent.setup();
    stubServer(chatOf([]));
    const queries: string[] = [];
    routes = (url) => {
      const query =
        /^\/api\/floors\/web-shop\/manager-chat\/files\?query=(.*)$/.exec(
          url,
        )?.[1];
      if (query === undefined) {
        return undefined;
      }
      queries.push(decodeURIComponent(query));
      return Response.json({
        files: [
          "src/checkout/total.ts",
          "src/checkout/tax.ts",
          "src/cart.ts",
        ].filter((path) => path.includes(decodeURIComponent(query))),
      });
    };
    renderPage();
    const box =
      await screen.findByLabelText<HTMLTextAreaElement>("Message Mira");
    await screen.findByText("Nothing yet. Write to Mira below.");
    await user.type(box, "Read @checkout");
    const list = await screen.findByRole("listbox", {
      name: "Files to mention",
    });
    // Fetched once typing stopped, not for every letter.
    expect(queries).not.toContain("che");
    expect(queries.at(-1)).toBe("checkout");
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "src/checkout/total.ts",
      "src/checkout/tax.ts",
    ]);
    expect(box.getAttribute("aria-controls")).toBe(list.id);
    expect(box.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    expect(box.value).toBe("Read @src/checkout/tax.ts ");
    expect(screen.queryByRole("listbox", { name: "Files to mention" })).toBe(
      null,
    );
    // Nothing was sent: Enter chose the file.
    expect(posts).toEqual([]);

    await user.type(box, "and @cart");
    await screen.findByRole("option", { name: "src/cart.ts" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Files to mention" })).toBe(
      null,
    );
    expect(box.value).toBe("Read @src/checkout/tax.ts and @cart");
  });

  it("chooses the Manager's own Model and effort in the header, never a Token Cap", async () => {
    const user = userEvent.setup();
    stubServer(chatOf([]));
    const manager: Agent = {
      id: "mira",
      floorId: "web-shop",
      name: "Mira",
      role: "manager",
      stage: null,
      aiProvider: "Claude",
      model: "claude-opus-5-5",
      modelOverride: null,
      effort: null,
      extraInstructions: "",
      enabled: true,
      avatar: randomAvatar(),
      tokenCaps: { daily: null, monthly: null },
      freshStartThreshold: null,
      createdAt: "2026-10-08T12:00:00.000Z",
      leavingAt: null,
      contractor: null,
    };
    let current = manager;
    const patches: { body: unknown; csrf: string | null }[] = [];
    routes = (url, init) => {
      if (url === "/api/floors/web-shop/agents") {
        return Response.json({ agents: [current] });
      }
      if (url === "/api/ai-providers") {
        return Response.json({
          aiProviders: [
            {
              aiProvider: "Claude",
              agentTool: "Claude Code",
              defaultModel: "claude-opus-5-5",
              models: [
                {
                  model: "claude-opus-5-5",
                  displayName: "Claude Opus 5.5",
                  contextWindow: 200_000,
                  accountTypes: ["api_key"],
                },
                {
                  model: "claude-sonnet-5-5",
                  displayName: "Claude Sonnet 5.5",
                  contextWindow: 200_000,
                  accountTypes: ["api_key"],
                },
              ],
              catalogueFetchedAt: "2026-10-10T09:00:00.000Z",
            },
          ],
        });
      }
      if (
        url === "/api/floors/web-shop/agents/mira" &&
        init?.method === "PATCH"
      ) {
        const body = JSON.parse(
          typeof init.body === "string" ? init.body : "{}",
        ) as Partial<Agent>;
        patches.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        current = {
          ...current,
          ...body,
          model: body.modelOverride ?? current.model,
        };
        return Response.json(current);
      }
      return undefined;
    };
    renderPage();
    const group = await screen.findByRole("group", {
      name: "Mira's Model and effort",
    });
    expect(group.textContent).toContain("changes no Token Cap");
    const model = within(group).getByLabelText<HTMLSelectElement>("Model");
    await waitFor(() => {
      expect(model.disabled).toBe(false);
    });
    expect(
      within(model)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Default (claude-opus-5-5)",
      "claude-opus-5-5 · Claude Opus 5.5 · 200,000 tokens",
      "claude-sonnet-5-5 · Claude Sonnet 5.5 · 200,000 tokens",
    ]);
    await user.selectOptions(model, "claude-sonnet-5-5");
    expect((await within(group).findByRole("status")).textContent).toBe(
      "Saved. Mira answers with claude-sonnet-5-5 from the next message.",
    );
    // The header names the Model now used.
    expect(screen.getByText(/The Manager of/).textContent).toContain(
      "claude-sonnet-5-5",
    );
    const effort = within(group).getByLabelText<HTMLSelectElement>("Effort");
    expect(
      within(effort)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Default", "low", "medium", "high", "xhigh", "max"]);
    await user.selectOptions(effort, "high");
    await waitFor(() => {
      expect(patches).toEqual([
        { body: { modelOverride: "claude-sonnet-5-5" }, csrf: "csrf" },
        { body: { effort: "high" }, csrf: "csrf" },
      ]);
    });
    expect(effort.value).toBe("high");
  });
});

describe("the Manager's status line (FR-24, FR-32, FR-36, FR-85)", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
    streams = [];
    vi.spyOn(eventSources, "open").mockImplementation((url) => {
      const source: FakeStream = {
        url,
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        close() {
          source.readyState = 2;
        },
        send(data: unknown) {
          source.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(data) }),
          );
        },
      };
      streams.push(source);
      return source;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const account = (
    id: string,
    name: string,
    fiveHour: number,
    weekly: number,
  ): AiAccount => ({
    id,
    name,
    aiProvider: "Claude",
    accountType: "oauth",
    endpointUrl: null,
    region: null,
    projectId: null,
    priority: 1,
    paused: false,
    tokenHealth: "valid",
    tokenExpiresAt: "2026-10-20T00:00:00.000Z",
    reauthenticationNeeded: false,
    limitReason: null,
    limitedUntil: null,
    usage: {
      fiveHour: {
        utilization: fiveHour,
        resetsAt: "2099-10-09T15:00:00.000Z",
      },
      weekly: { utilization: weekly, resetsAt: "2099-10-14T09:00:00.000Z" },
    },
    fiveHourPauseThreshold: null,
    weeklyPauseThreshold: null,
    forcedModel: null,
    extraUsage: null,
    createdAt: "2026-10-09T11:00:00.000Z",
    updatedAt: "2026-10-09T11:00:00.000Z",
  });

  const totals = (tokens: number) => ({
    requests: 1,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokens,
    estimatedCostUsd: 0,
  });

  /** The server's token usage, latest request and accounts, as a test sets them. */
  function stubUsage(state: {
    used: { daily: number; monthly: number };
    latestAccountId: string | null;
    accounts: AiAccount[];
  }) {
    routes = (url) => {
      if (url === "/api/floors/web-shop/token-usage") {
        return Response.json({
          floorId: "web-shop",
          caps: { daily: null, monthly: null },
          agentDefaults: {
            daily: { level: "office", cap: 1_000_000 },
            monthly: { level: "office", cap: 10_000_000 },
          },
          usage: {
            daily: totals(state.used.daily),
            monthly: totals(state.used.monthly),
          },
          agents: [
            {
              agentId: "mira",
              usage: {
                daily: totals(state.used.daily),
                monthly: totals(state.used.monthly),
              },
              caps: {
                daily: {
                  level: "office",
                  cap: 1_000_000,
                  used: state.used.daily,
                },
                monthly: {
                  level: "floor",
                  cap: 10_000_000,
                  used: state.used.monthly,
                },
              },
            },
          ],
          issues: [],
        });
      }
      if (url.startsWith("/api/gateway/requests?")) {
        const search = new URLSearchParams(url.split("?")[1]);
        expect(search.get("agentId")).toBe("mira");
        expect(search.get("limit")).toBe("1");
        return Response.json({
          requests:
            state.latestAccountId === null
              ? []
              : [
                  {
                    id: 9,
                    startedAt: "2026-10-09T12:00:00.000Z",
                    endpoint: "messages",
                    model: "claude-opus-5-5",
                    streamed: true,
                    status: 200,
                    latencyMs: 900,
                    timeToFirstByteMs: 100,
                    inputTokens: 10,
                    outputTokens: 5,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                    estimatedCostUsd: null,
                    account: "Work",
                    aiAccountId: state.latestAccountId,
                    agentId: "mira",
                    floorId: "web-shop",
                    ownerTool: null,
                    issue: null,
                    pullRequest: null,
                    upstreamRequestId: null,
                    keepAlive: false,
                  },
                ],
          nextBefore: null,
        });
      }
      if (url === "/api/ai-accounts") {
        return Response.json({ accounts: state.accounts });
      }
      return undefined;
    };
  }

  const meter = (name: string | RegExp) => screen.findByRole("meter", { name });

  it("shows the Manager's Context Usage, tokens against its Token Caps and its subscription's windows, kept live", async () => {
    stubServer(chatOf([]));
    const state = {
      used: { daily: 250_000, monthly: 1_000_000 },
      latestAccountId: "work" as string | null,
      accounts: [
        account("work", "Work", 36, 12),
        account("home", "Home", 90, 80),
      ],
    };
    stubUsage(state);
    renderPage();

    const line = await screen.findByLabelText("The Manager's usage");
    expect((await meter("Context Usage")).getAttribute("aria-valuenow")).toBe(
      "42",
    );
    const today = await meter(
      "Tokens today against the office's daily Token Cap",
    );
    expect(today.getAttribute("aria-valuetext")).toBe("250,000 of 1,000,000");
    expect(
      (
        await meter("Tokens this month against the Floor's monthly Token Cap")
      ).getAttribute("aria-valuetext"),
    ).toBe("1,000,000 of 10,000,000");
    await waitFor(() => {
      expect(line.textContent).toContain("Today 25%");
    });
    expect(line.textContent).toContain("This month 10%");
    // The account that served the Manager's latest request, not the other.
    const fiveHour = await meter(/^5-hour window used/);
    expect(fiveHour.getAttribute("aria-valuenow")).toBe("36");
    expect(
      (await meter(/^Weekly window used/)).getAttribute("aria-valuenow"),
    ).toBe("12");
    expect(line.textContent).toContain("Served by Work");
    expect(line.textContent).not.toContain("Home");

    // A model call of the Manager's, on the Floor's wall-board stream,
    // reads the tokens, the serving account and its windows again.
    state.used = { daily: 900_000, monthly: 2_000_000 };
    state.latestAccountId = "home";
    const wallBoard = streams.find(
      ({ url }) =>
        url.includes("floorId=web-shop") &&
        url.includes("model_call.completed"),
    );
    expect(wallBoard).toBeDefined();
    act(() => {
      wallBoard?.send({
        id: 30,
        occurredAt: "2026-10-09T12:01:00.000Z",
        event: {
          type: "model_call.completed",
          version: 1,
          floorId: "web-shop",
          agentId: "mira",
          aiAccount: "Home",
          aiProvider: "Claude",
          model: "claude-opus-5-5",
          status: 200,
          latencyMs: 900,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    });
    await waitFor(() => {
      expect(line.textContent).toContain("Today 90%");
    });
    await waitFor(() => {
      expect(line.textContent).toContain("Served by Home");
    });
    expect(
      (await meter(/^5-hour window used/)).getAttribute("aria-valuenow"),
    ).toBe("90");
  });

  it("names the Floor by the name the Owner chose, and follows a rename live (PRD FR-7)", async () => {
    stubServer(chatOf([]));
    stubUsage({
      used: { daily: 0, monthly: 0 },
      latestAccountId: null,
      accounts: [],
    });
    let name = "Web shop";
    const before = routes;
    routes = (url, init) =>
      url === "/api/floors/web-shop"
        ? Response.json({ ...floor, name })
        : before(url, init);
    renderPage();
    const link = await screen.findByRole("link", { name: "Web shop" });
    // Its address keeps the Floor's id.
    expect(link.getAttribute("href")).toBe("/floor-settings/web-shop");
    expect(screen.getByText(/The Manager of/).textContent).toContain(
      "The Manager of Web shop",
    );
    name = "Storefront";
    const wallBoard = streams.find(
      ({ url }) =>
        url.includes("floorId=web-shop") && url.includes("config.changed"),
    );
    act(() => {
      wallBoard?.send({
        id: 40,
        occurredAt: "2026-10-09T12:02:00.000Z",
        event: {
          type: "config.changed",
          version: 1,
          scope: "floor",
          floorId: "web-shop",
          keys: ["name"],
        },
      });
    });
    expect(
      (await screen.findByRole("link", { name: "Storefront" })).getAttribute(
        "href",
      ),
    ).toBe("/floor-settings/web-shop");
    expect(screen.getByText(/The Manager of/).textContent).toContain(
      "The Manager of Storefront",
    );
  });

  it("shows the windows of the Manager's AI Provider's subscriptions when no request names the account", async () => {
    stubServer(chatOf([]));
    stubUsage({
      used: { daily: 0, monthly: 0 },
      latestAccountId: null,
      accounts: [account("work", "Work", 36, 12)],
    });
    renderPage();
    const line = await screen.findByLabelText("The Manager's usage");
    expect(
      (await meter(/^5-hour window used/)).getAttribute("aria-valuenow"),
    ).toBe("36");
    expect(line.textContent).toContain("Work");
    expect(line.textContent).not.toContain("Served by");
  });
});

describe("withToolFrame", () => {
  it("adds each tool to its reply's, and ends them once the reply is kept", () => {
    const one = withToolFrame(
      {},
      { type: "tool", replyTo: 1, tool: { name: "Read", summary: "a.ts" } },
    );
    const two = withToolFrame(one, {
      type: "tool",
      replyTo: 1,
      tool: { name: "Grep", summary: "b" },
    });
    expect(two[1]?.map(({ name }) => name)).toEqual(["Read", "Grep"]);
    expect(withToolFrame(two, { type: "delta", replyTo: 1, text: "x" })).toBe(
      two,
    );
    expect(
      withToolFrame(two, {
        type: "message",
        message: message(2, "reply", "A"),
      }),
    ).toEqual({});
  });
});

describe("@ mentions", () => {
  it("finds the mention at the caret, and puts the chosen path in its place", () => {
    expect(mentionAt("see @src/ch", 11)).toEqual({ start: 4, query: "src/ch" });
    expect(mentionAt("mail a@b", 8)).toBeUndefined();
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(withMention("see @sr and", 7, "src/a.ts")).toEqual({
      text: "see @src/a.ts and",
      caret: 14,
    });
  });
});

describe("attachments", () => {
  it("knows a file's type by its extension when the browser does not say", () => {
    expect(mediaTypeOf({ name: "build.log", type: "" })).toBe("text/plain");
    expect(mediaTypeOf({ name: "a.yml", type: "" })).toBe("application/yaml");
    expect(mediaTypeOf({ name: "a.exe", type: "" })).toBeUndefined();
    expect(
      attachmentProblem({ name: "big.log", type: "text/plain", size: 2 << 20 }),
    ).toBe("big.log is too large: a text file is at most 1 MiB.");
  });
});

describe("withFrame", () => {
  const asked = chatOf([message(1, "owner", "Plan it?")]);

  it("starts a reply from its text so far, then adds each piece", () => {
    const started = withFrame(asked, {
      type: "pending",
      replyTo: 1,
      text: "Let me",
    });
    expect(started.pending).toEqual([{ replyTo: 1, text: "Let me" }]);
    expect(
      withFrame(started, { type: "delta", replyTo: 1, text: " think" }).pending,
    ).toEqual([{ replyTo: 1, text: "Let me think" }]);
    // After a reconnection the text so far replaces what was had.
    expect(
      withFrame(started, { type: "pending", replyTo: 1, text: "Let me think" })
        .pending,
    ).toEqual([{ replyTo: 1, text: "Let me think" }]);
  });

  it("adds each message once, in order, ending its pending reply", () => {
    const writing = withFrame(asked, { type: "delta", replyTo: 1, text: "A" });
    const kept = withFrame(writing, {
      type: "message",
      message: message(2, "reply", "A."),
    });
    expect(kept.pending).toEqual([]);
    expect(kept.messages.map(({ id }) => id)).toEqual([1, 2]);
    expect(
      withFrame(kept, { type: "message", message: message(2, "reply", "A.") }),
    ).toEqual(kept);
    expect(withFrame(kept, { type: "pending", replyTo: 1, text: "A" })).toEqual(
      kept,
    );
  });
});

function fail(): never {
  throw new Error("Not found.");
}
