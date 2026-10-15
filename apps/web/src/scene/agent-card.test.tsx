import {
  builtInRole,
  randomAvatar,
  type Agent,
  type CapUse,
  type FloorTokenUsage,
  type FloorWallBoard,
  type Role,
  type TokenTotals,
} from "@ai-office/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eventSources, type EventSourceLike } from "../event-stream.ts";
import { destination } from "./camera-rig.ts";
import { resetCamera, useCameraStore } from "./camera-store.ts";
import { floorInspectables } from "./inspectable.ts";
import { inspected } from "./inspection.ts";
import { InspectorPanel } from "./inspector.tsx";
import { resetSelection } from "./selection-store.ts";
import { webgl } from "./webgl.ts";

// An Agent's card (PRD FR-63), the panel clicking an Agent in the Office
// opens, against a stubbed server with a Floor at work: its name, Role, AI
// Provider, Model, current issue and tokens against its caps, kept live,
// and the way to its monitor, its config and its Avatar Editor.

const agent = (
  id: string,
  name: string,
  role: Role,
  overrides: Partial<Agent> = {},
): Agent => ({
  id,
  floorId: "web-shop",
  name,
  role,
  stage: builtInRole(role)?.stage ?? null,
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  freshStartThreshold: null,
  enabled: true,
  avatar: randomAvatar(),
  tokenCaps: { daily: null, monthly: null },
  createdAt: "2026-10-08T12:00:00.000Z",
  leavingAt: null,
  contractor: null,
  ...overrides,
});

const team = [
  agent("ada", "Ada", "manager"),
  agent("bo", "Bo", "coder", {
    aiProvider: "ChatGPT",
    model: "gpt-5.5-codex",
    modelOverride: "gpt-5.5-codex",
  }),
  agent("cy", "Cy", "reviewer"),
];

const issueUrl = (issue: number) =>
  `https://github.com/adrianeyre/web-shop/issues/${String(issue)}`;
const pullUrl = (pullRequest: number) =>
  `https://github.com/adrianeyre/web-shop/pull/${String(pullRequest)}`;

const work = (
  issue: number,
  overrides: Partial<FloorWallBoard["issues"][number]>,
): FloorWallBoard["issues"][number] => ({
  issue,
  url: issueUrl(issue),
  stage: "needs-work",
  status: "waiting",
  agentIds: [],
  pullRequest: null,
  reviewRounds: 0,
  qaRounds: 0,
  ...overrides,
});

/** Bo works #4 and has #9 waiting; #7 waits for Cy's review. */
const seededBoard = (): FloorWallBoard => ({
  floorId: "web-shop",
  roundCap: 3,
  qaRoundCap: 3,
  issues: [
    work(4, {
      status: "working",
      agentIds: ["bo"],
      pullRequest: { number: 12, url: pullUrl(12) },
    }),
    work(7, { stage: "needs-review", agentIds: ["cy"] }),
    work(9, { agentIds: ["bo"] }),
  ],
  queues: [],
  agents: [],
});

const totals = (tokens: number): TokenTotals => ({
  requests: tokens === 0 ? 0 : 1,
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  tokens,
  estimatedCostUsd: 0,
});

const capUse = (used: number, cap: number): CapUse => ({
  level: "agent",
  cap,
  used,
});

const agentUsage = (agentId: string, today: number, month: number) => ({
  agentId,
  usage: { daily: totals(today), monthly: totals(month) },
  caps: { daily: capUse(today, 1_000), monthly: capUse(month, 10_000) },
});

const seededUsage = (): FloorTokenUsage => ({
  floorId: "web-shop",
  caps: { daily: null, monthly: null },
  agentDefaults: {
    daily: { level: "office", cap: 1_000 },
    monthly: { level: "office", cap: 10_000 },
  },
  usage: { daily: totals(0), monthly: totals(0) },
  agents: [
    agentUsage("ada", 100, 200),
    agentUsage("bo", 850, 2_000),
    agentUsage("cy", 1_000, 10_000),
  ],
  issues: [],
});

/** The server, seeded for each test, which a test may change. */
const server = {
  board: seededBoard(),
  usage: seededUsage(),
  fail: false,
};

/** The live event streams the card opened, newest last. */
let streams: (EventSourceLike & { url: string; send(data: unknown): void })[];

beforeEach(() => {
  resetCamera();
  resetSelection();
  server.board = seededBoard();
  server.usage = seededUsage();
  server.fail = false;
  vi.spyOn(webgl, "available").mockReturnValue(false);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url === "/api/floors/web-shop/agents"
          ? Response.json({ agents: team })
          : url === "/api/floors/web-shop/agents/bo/chat"
            ? Response.json({
                name: "Bo",
                aiProvider: "ChatGPT",
                model: "gpt-5.5-codex",
                messages: [
                  {
                    id: 1,
                    kind: "owner",
                    text: "What are you on?",
                    replyTo: null,
                    model: "gpt-5.5-codex",
                    createdAt: "2026-10-09T12:00:00.000Z",
                  },
                  {
                    id: 2,
                    kind: "reply",
                    text: "Issue #4.",
                    replyTo: 1,
                    model: "gpt-5.5-codex",
                    createdAt: "2026-10-09T12:00:01.000Z",
                  },
                ],
                pending: [],
                models: [],
                // Its own conversation's Context Usage: 30,000 of 400,000.
                usage: {
                  model: "gpt-5.5-codex",
                  inputTokens: 30_000,
                  contextWindow: 400_000,
                  contextUsage: 0.075,
                  aiAccountId: null,
                  updatedAt: "2026-10-09T12:00:01.000Z",
                },
              })
            : url === "/api/floors/web-shop/manager-chat"
              ? Response.json({
                  manager: {
                    id: "ada",
                    name: "Ada",
                    aiProvider: "Claude",
                    model: "claude-opus-5-5",
                  },
                  messages: [],
                  pending: [],
                })
              : url === "/api/floors/web-shop/context-usage"
                ? Response.json({
                    agents: [
                      {
                        agentId: "ada",
                        floorId: "web-shop",
                        issue: null,
                        model: "claude-opus-5-5",
                        inputTokens: 60_000,
                        contextWindow: 200_000,
                        contextUsage: 0.3,
                        updatedAt: "2026-10-09T12:00:00.000Z",
                      },
                    ],
                  })
                : server.fail
                  ? Response.json({ error: "internal" }, { status: 500 })
                  : url === "/api/floors/web-shop/wall-board"
                    ? Response.json(server.board)
                    : url === "/api/floors/web-shop/token-usage"
                      ? Response.json(server.usage)
                      : url === "/api/notices?floorId=web-shop"
                        ? Response.json({ notices: [] })
                        : Response.json({}, { status: 404 }),
      ),
    ),
  );
  streams = [];
  vi.spyOn(eventSources, "open").mockImplementation((url) => {
    const source = {
      url,
      readyState: 0,
      onopen: null as EventSourceLike["onopen"],
      onmessage: null as EventSourceLike["onmessage"],
      onerror: null as EventSourceLike["onerror"],
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

/** The Agent's object in the Office, as clicking it there opens it. */
const agentObject = (agentId: string) =>
  floorInspectables("web-shop", team).find(
    ({ kind, id }) => kind === "agent" && id === agentId,
  ) ?? fail();

function renderCard(agentId: string, navigate?: (href: string) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <InspectorPanel object={agentObject(agentId)} navigate={navigate} />
    </QueryClientProvider>,
  );
}

const card = () => within(screen.getByRole("dialog"));

/** The card's facts, as term and description. */
const facts = () =>
  Object.fromEntries(
    [...screen.getByRole("dialog").querySelectorAll("dt")].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]),
  );

/** Waits until the card has read the Agent, its issue and its tokens. */
const loaded = async () => {
  await card().findByRole("button", { name: /monitor$/ });
  await waitFor(() => {
    expect(card().queryByText("Reading…")).toBeNull();
    expect(card().queryByText("Reading its tokens…")).toBeNull();
  });
};

/** A meter's reading, and the state it is coloured by. */
const meter = (name: string) => {
  const element = card().getByRole("meter", { name });
  return [
    element.getAttribute("aria-valuetext"),
    element.closest("[data-state]")?.getAttribute("data-state"),
  ];
};

describe("an Agent's card", () => {
  it("shows its name, Role, AI Provider, Model, current issue and tokens against its caps", async () => {
    renderCard("bo");
    await loaded();
    expect(card().getByRole("heading", { level: 2 }).textContent).toBe("Bo");
    expect(facts()).toEqual({
      Role: "Coder",
      "AI Provider": "ChatGPT",
      Model: "gpt-5.5-codex",
      "Current issue": "#4WorkWorkingPR #12",
    });
    // Its issue and pull request open on GitHub.
    expect(card().getByRole("link", { name: "#4" }).getAttribute("href")).toBe(
      issueUrl(4),
    );
    expect(
      card().getByRole("link", { name: "PR #12" }).getAttribute("href"),
    ).toBe(pullUrl(12));
    // Its tokens against its caps, coloured as the Office colours them.
    expect(meter("Bo's tokens today")).toEqual(["850 of 1,000", "warning"]);
    expect(meter("Bo's tokens this month")).toEqual([
      "2,000 of 10,000",
      "neutral",
    ]);
  });

  it("shows the issue an Agent waits for when it works none, its default Model, and a cap reached", async () => {
    renderCard("cy");
    await loaded();
    expect(facts()).toEqual({
      Role: "Reviewer",
      "AI Provider": "Claude",
      Model: "claude-opus-5-5 (default)",
      "Current issue": "#7ReviewWaiting",
    });
    expect(meter("Cy's tokens today")).toEqual(["1,000 of 1,000", "reached"]);
    expect(card().getByText("1,000 of 1,000 (reached)")).toBeTruthy();
  });

  it("opens a chat with the Agent in its place, and goes back to the card", async () => {
    const user = userEvent.setup();
    renderCard("bo");
    await loaded();
    await user.click(card().getByRole("button", { name: "Chat with Bo" }));
    const log = await card().findByRole("log", { name: "Chat with Bo" });
    await waitFor(() => {
      expect(
        within(log)
          .getAllByRole("listitem")
          .map((item) => item.dataset["kind"]),
      ).toEqual(["owner", "reply"]);
    });
    expect(within(log).getByText("Issue #4.")).toBeTruthy();
    expect(streams.map(({ url }) => url)).toContain(
      "/api/floors/web-shop/agents/bo/chat/stream?lastEventId=2",
    );
    // Its status line, compact: its chat's own Context Usage, and its
    // tokens against its Token Caps, kept live by its requests.
    const line = card().getByLabelText("Bo's usage");
    expect(
      within(line)
        .getByRole("meter", { name: "Context Usage" })
        .getAttribute("aria-valuenow"),
    ).toBe("7");
    await waitFor(() => {
      expect(line.textContent).toContain("Today 85%");
    });
    expect(line.textContent).toContain("This month 20%");
    expect(line.parentElement?.textContent).toContain("Modelgpt-5.5-codex");
    expect(streams.map(({ url }) => url)).toContain(
      "/api/gateway/requests/stream?floorId=web-shop&agentId=bo",
    );
    await user.click(card().getByRole("button", { name: "Back to Bo's card" }));
    expect(
      await card().findByRole("button", { name: "Chat with Bo" }),
    ).toBeTruthy();
  });

  it("opens the Manager chat for the Manager", async () => {
    const user = userEvent.setup();
    renderCard("ada");
    await loaded();
    await user.click(card().getByRole("button", { name: "Chat with Ada" }));
    expect(
      await card().findByRole("log", { name: "Manager chat" }),
    ).toBeTruthy();
    // The Manager's status line, compact, over its chat (a Grilling
    // Session's panel shows the same chat).
    const line = await card().findByLabelText("The Manager's usage");
    await waitFor(() => {
      expect(
        within(line)
          .getByRole("meter", { name: "Context Usage" })
          .getAttribute("aria-valuenow"),
      ).toBe("30");
    });
    await waitFor(() => {
      expect(line.textContent).toContain("Today 10%");
    });
    expect(
      card().getByRole("link", { name: "Open the Manager chat" }),
    ).toBeTruthy();
    // What can be typed folds away, so the narrow card keeps its box.
    const hint = card().getByText("What you can type");
    expect(hint.tagName).toBe("SUMMARY");
    expect(hint.closest("details")?.open).toBe(false);
  });

  it("says when an Agent is on no issue", async () => {
    renderCard("ada");
    await loaded();
    expect(facts()["Current issue"]).toBe("None");
  });

  it("says so when its issue or tokens cannot be read", async () => {
    server.fail = true;
    renderCard("bo");
    await card().findByText("Its tokens could not be read.");
    await waitFor(() => {
      expect(facts()["Current issue"]).toBe("Could not be read");
    });
    // What it is, it still says.
    expect(facts()["Role"]).toBe("Coder");
  });

  it("follows the Floor's events: a new issue and new tokens show at once", async () => {
    renderCard("ada");
    await loaded();
    const stream =
      streams.find(({ url }) => url.includes("floorId=web-shop")) ?? fail();
    expect(stream.url).toContain("issue.assigned");
    expect(stream.url).toContain("model_call.completed");

    server.board = {
      ...seededBoard(),
      issues: [work(11, { status: "working", agentIds: ["ada"] })],
    };
    server.usage = {
      ...seededUsage(),
      agents: [agentUsage("ada", 900, 900)],
    };
    act(() => {
      stream.send({
        id: 2,
        occurredAt: "2026-10-09T12:00:00.000Z",
        event: {
          type: "issue.assigned",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          issue: 11,
        },
      });
    });
    await waitFor(() => {
      expect(facts()["Current issue"]).toBe("#11WorkWorking");
    });
    await waitFor(() => {
      expect(meter("Ada's tokens today")).toEqual(["900 of 1,000", "warning"]);
    });
  });

  it("opens the Agent's monitor, flying the camera to it", async () => {
    renderCard("bo");
    await loaded();
    await userEvent
      .setup()
      .click(card().getByRole("button", { name: "Open Bo's monitor" }));
    expect(inspected()).toEqual({ kind: "monitor", id: "bo" });
    expect(destination(useCameraStore.getState().rig)).toBe(
      "inspect:monitor:bo",
    );
  });

  it("links to the Agent's config, in Agent Settings, without a reload", async () => {
    const navigate = vi.fn();
    renderCard("bo", navigate);
    await loaded();
    const config = card().getByRole("link", { name: "Open Bo's config" });
    expect(config.getAttribute("href")).toBe(
      "/agent-settings?floor=web-shop&agent=bo",
    );
    await userEvent.setup().click(config);
    expect(navigate).toHaveBeenCalledWith(
      "/agent-settings?floor=web-shop&agent=bo",
    );
  });

  it("opens the Avatar Editor in its place, and goes back to the card", async () => {
    const user = userEvent.setup();
    renderCard("bo");
    await loaded();
    await user.click(
      card().getByRole("button", { name: "Open Bo's Avatar Editor" }),
    );
    const editor = within(card().getByRole("form", { name: "Bo's Avatar" }));
    expect(editor.getByText(/How Bo looks in the Office\./)).toBeTruthy();
    expect(editor.getByRole("button", { name: "Randomise" })).toBeTruthy();
    expect(card().queryByText("Current issue")).toBeNull();

    await user.click(card().getByRole("button", { name: "Back to Bo's card" }));
    expect(card().queryByRole("form")).toBeNull();
    expect(facts()["Role"]).toBe("Coder");
  });

  it("marks a Contractor, by its one-off Role, and keeps it on the team (ADR 0004)", async () => {
    const mo = agent("mo", "Migration writer", "contractor-1a2b3c4d5e", {
      stage: "work",
      contractor: {
        kind: "work",
        batchId: 4,
        oneOffRole: {
          name: "Migration writer",
          description: "Writes database migrations.",
        },
      },
    });
    const posted: { url: string; csrf: string | null }[] = [];
    const served = vi.mocked(fetch).getMockImplementation();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/session") {
          return Promise.resolve(
            Response.json({
              csrfToken: "csrf-token-1",
              expiresAt: "2026-10-15T12:00:00.000Z",
            }),
          );
        }
        if (url === "/api/floors/web-shop/agents/mo/keep") {
          posted.push({
            url,
            csrf: new Headers(init?.headers).get("x-csrf-token"),
          });
          return Promise.resolve(Response.json({ ...mo, contractor: null }));
        }
        if (url === "/api/floors/web-shop/agents") {
          return Promise.resolve(Response.json({ agents: [...team, mo] }));
        }
        return served?.(url) ?? Promise.resolve(Response.json({}));
      }),
    );
    const object =
      floorInspectables("web-shop", [...team, mo]).find(
        ({ kind, id }) => kind === "agent" && id === "mo",
      ) ?? fail();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <InspectorPanel object={object} />
      </QueryClientProvider>,
    );
    await loaded();
    expect(facts()["Role"]).toBe("Migration writerContractor, Batch 4");
    const keep = await card().findByRole("button", {
      name: "Keep Migration writer on the team",
    });
    await waitFor(() => {
      expect((keep as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.setup().click(keep);
    await waitFor(() => {
      expect(posted).toEqual([
        {
          url: "/api/floors/web-shop/agents/mo/keep",
          csrf: "csrf-token-1",
        },
      ]);
    });
  });

  it("offers an ordinary Agent no Keep on the team", async () => {
    renderCard("bo");
    await loaded();
    expect(card().queryByRole("button", { name: /on the team$/ })).toBeNull();
  });
});

function fail(): never {
  throw new Error("Not found.");
}
