import {
  builtInRole,
  randomAvatar,
  type Agent,
  type CapUse,
  type FloorTokenUsage,
  type FloorWallBoard,
  type Notice,
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
import { resetSelection } from "./selection-store.ts";
import { FloorWallBoardPanel } from "./wall-board-panel.tsx";

// A Floor's wall board panel (PRD FR-50, FR-57, FR-58), against a stubbed
// server seeded with a Floor at work: its health, Notices, issues in
// progress with their Agents, stages and links, queues, rounds and tokens
// against caps, kept live by the Floor's events.

const agent = (id: string, name: string, role: Role): Agent => ({
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
});

const team = [
  agent("ada", "Ada", "manager"),
  agent("bo", "Bo", "coder"),
  agent("cy", "Cy", "reviewer"),
  agent("di", "Di", "qa"),
];

const notice = (id: string, overrides: Partial<Notice> = {}): Notice => ({
  id,
  kind: "info",
  title: "PR #12 opened",
  floorId: "web-shop",
  agentId: null,
  issue: null,
  pullRequest: null,
  ciRunUrl: null,
  actions: [],
  createdAt: "2026-10-09T12:00:00.000Z",
  dismissedAt: null,
  actedAt: null,
  actedOn: null,
  links: [],
  positions: [],
  ...overrides,
});

const issueUrl = (issue: number) =>
  `https://github.com/adrianeyre/web-shop/issues/${String(issue)}`;
const pullUrl = (pullRequest: number) =>
  `https://github.com/adrianeyre/web-shop/pull/${String(pullRequest)}`;

const seededBoard = (): FloorWallBoard => ({
  floorId: "web-shop",
  roundCap: 3,
  qaRoundCap: 3,
  issues: [
    {
      issue: 4,
      url: issueUrl(4),
      stage: "needs-work",
      status: "working",
      agentIds: ["bo"],
      pullRequest: null,
      reviewRounds: 0,
      qaRounds: 0,
    },
    {
      issue: 7,
      url: issueUrl(7),
      stage: "needs-review",
      status: "waiting",
      agentIds: ["cy"],
      pullRequest: { number: 12, url: pullUrl(12) },
      reviewRounds: 1,
      qaRounds: 1,
    },
    {
      issue: 9,
      url: issueUrl(9),
      stage: "needs-work",
      status: "waiting",
      agentIds: ["bo"],
      pullRequest: null,
      reviewRounds: 0,
      qaRounds: 0,
    },
  ],
  queues: [
    { stage: "needs-work", waiting: 1, working: 1 },
    { stage: "needs-review", waiting: 1, working: 0 },
    { stage: "needs-qa", waiting: 0, working: 0 },
    { stage: "needs-docs", waiting: 0, working: 0 },
  ],
  agents: [
    { agentId: "ada", waiting: 0, awaitingReview: [], capped: false },
    { agentId: "bo", waiting: 1, awaitingReview: [], capped: false },
    { agentId: "cy", waiting: 0, awaitingReview: [], capped: false },
    { agentId: "di", waiting: 0, awaitingReview: [], capped: false },
  ],
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
  level: "office",
  cap,
  used,
});

const agentUsage = (agentId: string, today: number, month = today) => ({
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
  usage: { daily: totals(1_400), monthly: totals(1_400) },
  agents: [
    agentUsage("ada", 100),
    agentUsage("bo", 1_000),
    agentUsage("cy", 300),
    agentUsage("di", 0),
  ],
  issues: [],
});

/** The server, seeded for each test, which a test may change. */
const server = {
  notices: [] as Notice[],
  board: seededBoard(),
  usage: seededUsage(),
  failBoard: false,
};

/** The paths the panel fetched. */
let fetched: string[];

/** The live event streams the panel opened, newest last. */
let streams: (EventSourceLike & { url: string; send(data: unknown): void })[];

beforeEach(() => {
  resetCamera();
  resetSelection();
  server.notices = [
    notice("n-1", {
      kind: "action",
      title: "Round Cap reached",
      agentId: "cy",
      issue: { number: 5, url: issueUrl(5) },
      pullRequest: { number: 10, url: pullUrl(10) },
      links: [{ label: "Review round 1", url: `${pullUrl(10)}#r1` }],
    }),
    notice("n-2", {
      title: "PR #12 opened",
      agentId: "bo",
      issue: { number: 7, url: issueUrl(7) },
      pullRequest: { number: 12, url: pullUrl(12) },
      ciRunUrl: "https://github.com/adrianeyre/web-shop/actions/runs/1",
    }),
  ];
  server.board = seededBoard();
  server.usage = seededUsage();
  server.failBoard = false;
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      return Promise.resolve(
        url === "/api/notices?floorId=web-shop"
          ? Response.json({ notices: server.notices })
          : url === "/api/floors/web-shop/wall-board"
            ? server.failBoard
              ? Response.json({ error: "internal" }, { status: 500 })
              : Response.json(server.board)
            : url === "/api/floors/web-shop/token-usage"
              ? Response.json(server.usage)
              : url === "/api/floors/web-shop/agents"
                ? Response.json({ agents: team })
                : Response.json({}, { status: 404 }),
      );
    }),
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

function renderPanel(navigate?: (href: string) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FloorWallBoardPanel floorId="web-shop" navigate={navigate} />
    </QueryClientProvider>,
  );
}

/** One of the board's parts, by its heading. */
const part = (name: RegExp | string) =>
  within(screen.getByRole("heading", { name }).closest("section") ?? fail());

/** Every link in an element, as text and address. */
const linksIn = (element: ReturnType<typeof part>) =>
  element
    .queryAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);

/** Waits until everything on the board has been read. */
const loaded = async () => {
  await screen.findByRole("heading", { name: "Tokens against caps" });
  await screen.findByRole("heading", { name: /^Notices \(/ });
  await waitFor(() => {
    expect(screen.queryByText("Reading the Floor…")).toBeNull();
  });
};

describe("a Floor's wall board panel", () => {
  it("shows the Floor's Notices, with their links", async () => {
    const navigate = vi.fn();
    renderPanel(navigate);
    await loaded();
    const notices = part("Notices (2)");
    expect(notices.getByText("Round Cap reached")).toBeTruthy();
    expect(notices.getByText("PR #12 opened")).toBeTruthy();
    expect(linksIn(notices)).toEqual([
      ["Issue #5", issueUrl(5)],
      ["PR #10", pullUrl(10)],
      ["Review round 1", `${pullUrl(10)}#r1`],
      ["Issue #7", issueUrl(7)],
      ["PR #12", pullUrl(12)],
      ["CI run", "https://github.com/adrianeyre/web-shop/actions/runs/1"],
      ["Open this Floor's Notices", "/notices?floorId=web-shop"],
    ]);
    // GitHub's links open in a new tab; the 2D Notice Board without a reload.
    for (const link of notices.getAllByRole("link").slice(0, -1)) {
      expect(link.getAttribute("target")).toBe("_blank");
    }
    await userEvent
      .setup()
      .click(notices.getByRole("link", { name: "Open this Floor's Notices" }));
    expect(navigate).toHaveBeenCalledWith("/notices?floorId=web-shop");
    // Each Notice's Agent, by name.
    expect(
      notices.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Cy", "Bo"]);
  });

  it("shows every issue in progress with its Agent, its stage, its links and its rounds", async () => {
    renderPanel();
    await loaded();
    const inProgress = part("In progress (3)");
    const issues = within(
      inProgress.getByRole("list", { name: "Issues in progress" }),
    )
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(issues).toEqual([
      "#4WorkWorkingBy BoReview rounds 0 of 3",
      "#7ReviewWaitingPR #12For CyReview rounds 1 of 3 · QA rounds 1 of 3",
      "#9WorkWaitingFor BoReview rounds 0 of 3",
    ]);
    expect(linksIn(inProgress)).toEqual([
      ["#4", issueUrl(4)],
      ["#7", issueUrl(7)],
      ["PR #12", pullUrl(12)],
      ["#9", issueUrl(9)],
    ]);
    // Each stage in its colour, from the palette.
    expect(inProgress.getByText("Review").className).toContain(
      "bg-office-stage-review",
    );
  });

  it("shows the Floor's queues, by stage and by Agent", async () => {
    renderPanel();
    await loaded();
    const queues = part("Queues");
    expect(
      queues
        .getAllByRole("row")
        .map((row) =>
          [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
        ),
    ).toEqual([
      ["Stage", "Waiting", "Working"],
      ["Work", "1", "1"],
      ["Review", "1", "0"],
      ["QA", "0", "0"],
      ["Docs", "0", "0"],
    ]);
    expect(
      within(queues.getByRole("list", { name: "Waiting for each Agent" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Bo: 1 task waiting"]);
  });

  it("shows each Agent's tokens against its caps, coloured as the Office colours them", async () => {
    server.usage = {
      ...seededUsage(),
      agents: [
        agentUsage("ada", 100),
        agentUsage("bo", 1_000, 1_000),
        agentUsage("cy", 850, 9_000),
        agentUsage("di", 0),
      ],
    };
    renderPanel();
    await loaded();
    const tokens = part("Tokens against caps");
    const meter = (label: string) => tokens.getByRole("meter", { name: label });
    const stateOf = (label: string) =>
      meter(label).parentElement?.dataset["state"];

    expect(meter("Ada's tokens today").getAttribute("aria-valuetext")).toBe(
      "100 of 1,000",
    );
    expect(stateOf("Ada's tokens today")).toBe("neutral");
    // At 80% and more, amber; at 100%, red.
    expect(stateOf("Cy's tokens today")).toBe("warning");
    expect(stateOf("Cy's tokens this month")).toBe("warning");
    expect(stateOf("Bo's tokens today")).toBe("reached");
    expect(stateOf("Bo's tokens this month")).toBe("neutral");
    expect(meter("Bo's tokens today").firstElementChild?.className).toContain(
      "bg-office-state-critical",
    );
    expect(meter("Cy's tokens today").firstElementChild?.className).toContain(
      "bg-office-state-warning",
    );
    expect(tokens.getByText("1,000 of 1,000 (reached)")).toBeTruthy();
    // Each Agent is named, with its Role.
    expect(tokens.getByText("(coder)")).toBeTruthy();
  });

  describe("the Floor's health", () => {
    const health = () => {
      const shown = part("Health");
      const status = shown.getByText(
        /^(Running smoothly|Worth watching|Needs you)$/,
      );
      return {
        level: status.dataset["health"],
        label: status.textContent,
        reasons:
          shown.queryByRole("list", { name: "Why" })?.querySelectorAll("li") ??
          [],
      };
    };
    const reasonsOf = (shown: ReturnType<typeof health>) =>
      [...shown.reasons].map((reason) => reason.textContent);

    it("needs the Owner with an action Notice open, or an Agent at its cap", async () => {
      renderPanel();
      await loaded();
      const shown = health();
      expect(shown).toMatchObject({ level: "critical", label: "Needs you" });
      expect(reasonsOf(shown)).toEqual([
        "1 action Notice open.",
        "Bo has reached its daily Token Cap.",
      ]);
    });

    it("is worth watching near a cap, with one round left, or with work no Agent can do", async () => {
      server.notices = [notice("n-2")];
      server.usage = {
        ...seededUsage(),
        agents: [agentUsage("bo", 800), agentUsage("cy", 0)],
      };
      server.board = {
        ...seededBoard(),
        issues: [
          {
            ...(seededBoard().issues[1] ?? fail()),
            reviewRounds: 2,
            qaRounds: 2,
          },
          {
            ...(seededBoard().issues[0] ?? fail()),
            status: "waiting",
            agentIds: [],
          },
        ],
      };
      renderPanel();
      await loaded();
      const shown = health();
      expect(shown).toMatchObject({
        level: "warning",
        label: "Worth watching",
      });
      expect(reasonsOf(shown)).toEqual([
        "Bo has used 80% of its daily Token Cap.",
        "#7 has used 2 of 3 review rounds.",
        "#7 has used 2 of 3 QA rounds.",
        "#4 waits with no Agent to work it.",
      ]);
      expect(
        part("In progress (2)").getByText("No Agent to work it"),
      ).toBeTruthy();
    });

    it("is running smoothly otherwise", async () => {
      server.notices = [];
      server.usage = { ...seededUsage(), agents: [agentUsage("bo", 10)] };
      server.board = { ...seededBoard(), issues: [] };
      renderPanel();
      await loaded();
      expect(health()).toMatchObject({
        level: "ok",
        label: "Running smoothly",
      });
      expect(reasonsOf(health())).toEqual([]);
      expect(
        part("Notices (0)").getByText(
          "No Notices: nothing on this Floor needs you.",
        ),
      ).toBeTruthy();
      expect(
        part("In progress (0)").getByText("No issue is in progress."),
      ).toBeTruthy();
    });
  });

  it("flies to an Agent from its name, opening its card (PRD FR-63)", async () => {
    renderPanel();
    await loaded();
    await userEvent.setup().click(
      within(
        part("In progress (3)").getByRole("list", {
          name: "Issues in progress",
        }),
      ).getAllByRole("button", { name: "Cy" })[0] ?? fail(),
    );
    expect(inspected()).toEqual({ kind: "agent", id: "cy" });
    expect(destination(useCameraStore.getState().rig)).toBe("inspect:agent:cy");
    expect(useCameraStore.getState().views["inspect:agent:cy"]).toEqual(
      floorInspectables("web-shop", team).find(
        ({ kind, id }) => kind === "agent" && id === "cy",
      )?.view,
    );
  });

  it("reads the board again as the Floor's events come, and as its Notices change", async () => {
    renderPanel();
    await loaded();
    const floorStream =
      streams.find(({ url }) => url.includes("floorId=web-shop")) ?? fail();
    expect(floorStream.url).toContain("issue.assigned");
    expect(floorStream.url).toContain("review.posted");
    expect(floorStream.url).toContain("cap.reached");

    server.board = {
      ...seededBoard(),
      issues: [
        ...seededBoard().issues,
        {
          issue: 11,
          url: issueUrl(11),
          stage: "needs-qa",
          status: "working",
          agentIds: ["di"],
          pullRequest: { number: 14, url: pullUrl(14) },
          reviewRounds: 1,
          qaRounds: 0,
        },
      ],
    };
    server.usage = {
      ...seededUsage(),
      agents: [agentUsage("di", 950)],
    };
    act(() => {
      floorStream.send({
        id: 41,
        occurredAt: "2026-10-09T12:00:41.000Z",
        event: {
          type: "issue.assigned",
          version: 1,
          floorId: "web-shop",
          issue: 11,
          agentId: "di",
        },
      });
    });
    await screen.findByRole("heading", { name: "In progress (4)" });
    expect(
      part("In progress (4)").getByRole("link", { name: "#11" }),
    ).toBeTruthy();
    // Its tokens are read again too.
    await waitFor(() => {
      expect(
        part("Tokens against caps")
          .getByRole("meter", { name: "Di's tokens today" })
          .getAttribute("aria-valuetext"),
      ).toBe("950 of 1,000");
    });

    // A Notice taken off the board leaves the panel too, on the same one
    // stream: the panel opens no other.
    expect(streams).toHaveLength(1);
    expect(floorStream.url).toContain("notice.dismissed");
    server.notices = server.notices.slice(1);
    act(() => {
      floorStream.send({
        id: 42,
        occurredAt: "2026-10-09T12:00:42.000Z",
        event: {
          type: "notice.dismissed",
          version: 1,
          noticeId: "n-1",
          floorId: "web-shop",
        },
      });
    });
    await screen.findByRole("heading", { name: "Notices (1)" });
    expect(screen.queryByText("Round Cap reached")).toBeNull();
  });

  it("says so when the board cannot be read, and shows the rest", async () => {
    server.failBoard = true;
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Some of this Floor's wall board could not be loaded.",
    );
    await screen.findByRole("heading", { name: "Notices (2)" });
    expect(
      screen.getByRole("heading", { name: "Tokens against caps" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Queues" })).toBeNull();
    expect(fetched).toContain("/api/floors/web-shop/wall-board");
  });
});

function fail(): never {
  throw new Error("Not found.");
}
