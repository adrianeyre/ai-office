import type { OfficeEvent } from "@ai-office/events/schema";
import type { StreamedEvent } from "@ai-office/events/stream";
import {
  builtInRole,
  randomAvatar,
  type Agent,
  type Floor,
  type FloorWallBoard,
  type Notice,
  type Role,
} from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
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

import { agentStateText } from "./agent-status.tsx";
import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import {
  agentEntryId,
  floorSectionId,
  latestActivity,
  office2dSections,
  office2dTargetId,
} from "./office-2d.tsx";
import { phoneQuery } from "./phone-view.ts";
import { createAppRouter } from "./router.tsx";

// The Office on a phone (PRD §7): a 2D view in place of the 3D one, with
// the Notice Board, the latest activity, every Floor with its Agents and
// issues, and Settings, against a stubbed server, with the live event stream
// driven by the test. The 3D view is a stand-in, so a test sees which one
// the Office shows.

vi.mock("./scene/office-view.tsx", () => ({
  OfficeView: () => <div data-testid="office-3d" />,
}));

const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 9, 12, 0, second)).toISOString();

const floor = (id: string): Floor => ({
  id,
  name: id,
  repository: `adrianeyre/${id}`,
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office",
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
  createdAt: at(0),
  archivedAt: null,
});

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
  avatar: randomAvatar(() => 0.5, []),
  tokenCaps: { daily: null, monthly: null },
  createdAt: at(0),
  leavingAt: null,
  contractor: null,
  ...overrides,
});

const team = [
  agent("ada", "Ada", "manager"),
  agent("bo", "Bo", "coder"),
  agent("cy", "Cy", "reviewer"),
  agent("di", "Di", "qa", { enabled: false }),
];

const issueUrl = (issue: number) =>
  `https://github.com/adrianeyre/web-shop/issues/${String(issue)}`;

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
      pullRequest: {
        number: 12,
        url: "https://github.com/adrianeyre/web-shop/pull/12",
      },
      reviewRounds: 1,
      qaRounds: 0,
    },
  ],
  queues: [],
  agents: [
    { agentId: "ada", waiting: 0, awaitingReview: [], capped: false },
    { agentId: "bo", waiting: 2, awaitingReview: [7], capped: false },
    { agentId: "cy", waiting: 1, awaitingReview: [], capped: true },
    { agentId: "di", waiting: 0, awaitingReview: [], capped: false },
  ],
});

const notice: Notice = {
  id: "n-1",
  kind: "action",
  title: "PR #12 awaiting your approval",
  floorId: "web-shop",
  agentId: "bo",
  issue: { number: 7, url: issueUrl(7) },
  pullRequest: null,
  ciRunUrl: null,
  actions: [{ id: "approve_and_merge", label: "Approve and merge" }],
  createdAt: at(1),
  dismissedAt: null,
  actedAt: null,
  actedOn: null,
  links: [],
  positions: [],
};

const stored = (id: number, event: OfficeEvent): StreamedEvent => ({
  id,
  occurredAt: at(id),
  event,
});

const floorCreated = (id: number, name: string) =>
  stored(id, {
    type: "floor.created",
    version: 1,
    floorId: name,
    name,
    repository: `adrianeyre/${name}`,
  });

/** The server, seeded for each test, which a test may change. */
const server = {
  floorName: "web-shop",
  board: seededBoard(),
  events: [] as StreamedEvent[],
};

let fetched: string[];

interface FakeStream extends Omit<EventSourceLike, "readyState"> {
  readyState: number;
  readonly url: string;
  send(data: unknown): void;
}

let streams: FakeStream[];

/** Element.scrollIntoView, which jsdom lacks. */
let scrolled: ReturnType<
  typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>
>;

/** The screen: a phone's, or not, as the test turns it. */
const display = {
  phone: true,
  listeners: new Set<() => void>(),
  turn(phone: boolean) {
    display.phone = phone;
    for (const listener of display.listeners) {
      listener();
    }
  },
};

function stubServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      const path = new URL(url, "http://office").pathname;
      const answer =
        url === "/api/session"
          ? { csrfToken: "csrf", expiresAt: at(59) }
          : url === "/health"
            ? { status: "ok", database: "up" }
            : url === "/api/floors"
              ? { floors: [{ ...floor("web-shop"), name: server.floorName }] }
              : url === "/api/notices"
                ? { notices: [notice] }
                : url === "/api/notices?floorId=web-shop"
                  ? { notices: [notice] }
                  : url === "/api/floors/web-shop/agents"
                    ? { agents: team }
                    : url === "/api/floors/web-shop/wall-board"
                      ? server.board
                      : url === "/api/floors/web-shop/token-usage"
                        ? {
                            floorId: "web-shop",
                            caps: { daily: null, monthly: null },
                            agentDefaults: {
                              daily: { level: "office", cap: 1_000 },
                              monthly: { level: "office", cap: 10_000 },
                            },
                            usage: {
                              daily: totals,
                              monthly: totals,
                            },
                            agents: [],
                            issues: [],
                          }
                        : path === "/api/events"
                          ? {
                              events: server.events
                                .toReversed()
                                .slice(
                                  0,
                                  Number(
                                    new URL(
                                      url,
                                      "http://office",
                                    ).searchParams.get("limit") ?? 50,
                                  ),
                                ),
                              nextBefore: null,
                            }
                          : undefined;
      return Promise.resolve(
        answer === undefined
          ? Response.json({}, { status: 404 })
          : Response.json(answer),
      );
    }),
  );
}

const totals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  tokens: 0,
  estimatedCostUsd: 0,
};

beforeEach(() => {
  server.floorName = "web-shop";
  server.board = seededBoard();
  server.events = [floorCreated(1, "web-shop"), floorCreated(2, "blog")];
  fetched = [];
  display.phone = true;
  display.listeners.clear();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === phoneQuery && display.phone;
    },
    addEventListener: (_type: string, listener: () => void) => {
      if (query === phoneQuery) {
        display.listeners.add(listener);
      }
    },
    removeEventListener: (_type: string, listener: () => void) => {
      display.listeners.delete(listener);
    },
  }));
  scrolled = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  Element.prototype.scrollIntoView = scrolled;
  stubServer();
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

function renderAt(path: string) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <App
      router={router}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  return router;
}

/** A section of the page, by its heading. */
const section = async (name: string) =>
  within(
    (await screen.findByRole("heading", { name, level: 2 })).closest(
      "section",
    ) ?? fail(),
  );

/** The open stream whose address names a type, or names none. */
const streamFor = (type: string | undefined) =>
  streams.findLast(
    ({ url, readyState }) =>
      readyState !== 2 &&
      (type === undefined
        ? !url.includes("type=")
        : decodeURIComponent(url).includes(type)),
  ) ?? fail(`No stream for ${type ?? "every event"}.`);

/** An Agent's entry on its Floor, once its Floor is read. */
const agentEntry = async (name: string) =>
  (await screen.findByRole("heading", { name, level: 4 })).closest("li") ??
  fail();

describe("the Office on a phone", () => {
  it("shows the 2D view, never the 3D one, with every section in reach from the top", async () => {
    renderAt("/");
    await screen.findByTestId("office-2d");
    expect(screen.queryByTestId("office-3d")).toBeNull();
    const sections = within(
      screen.getByRole("navigation", { name: "Office sections" }),
    );
    expect(
      sections
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Notice Board", `#${office2dSections.notices}`],
      ["Activity", `#${office2dSections.activity}`],
      ["Floors", `#${office2dSections.floors}`],
      ["Settings", `#${office2dSections.admin}`],
    ]);
    for (const name of ["Notice Board", "Activity", "Floors", "Settings"]) {
      expect(
        screen.getByRole("heading", { name, level: 2 }).closest("section")?.id,
      ).toBe(
        office2dSections[
          name === "Notice Board"
            ? "notices"
            : name === "Settings"
              ? "admin"
              : (name.toLowerCase() as "activity" | "floors")
        ],
      );
    }

    // Each takes focus, and comes into view, from its link.
    const user = userEvent.setup();
    await user.click(sections.getByRole("link", { name: "Floors" }));
    expect(document.activeElement?.id).toBe(office2dSections.floors);
    expect(scrolled).toHaveBeenCalled();
  });

  it("shows the Notice Board, with each Notice's actions", async () => {
    renderAt("/");
    const notices = await section("Notice Board");
    expect(
      await notices.findByText("PR #12 awaiting your approval"),
    ).toBeTruthy();
    expect(
      notices.getByRole("button", { name: "Approve and merge" }),
    ).toBeTruthy();
    expect(notices.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(
      notices
        .getByRole("link", { name: "Open the Notice Board" })
        .getAttribute("href"),
    ).toBe("/notices");
  });

  it("shows the latest activity, newest first, and streams new events in at the top", async () => {
    renderAt("/");
    const activity = await section("Activity");
    const texts = () =>
      within(activity.getByRole("list", { name: "Latest activity" }))
        .getAllByRole("listitem")
        .filter((item) => item.querySelector("time") !== null)
        .map((item) => item.querySelector("p")?.textContent);
    await waitFor(() => {
      expect(texts()).toEqual([
        'Floor "blog" added for adrianeyre/blog.',
        'Floor "web-shop" added for adrianeyre/web-shop.',
      ]);
    });
    expect(
      fetched.some((url) => url.includes(`limit=${String(latestActivity)}`)),
    ).toBe(true);

    act(() => {
      streamFor(undefined).send(floorCreated(3, "docs"));
    });
    await waitFor(() => {
      expect(texts()[0]).toBe('Floor "docs" added for adrianeyre/docs.');
    });
    expect(
      activity
        .getByRole("link", { name: "Open the Activity Feed" })
        .getAttribute("href"),
    ).toBe("/activity");
  });

  it("shows each Floor's Agents, in the states the Office shows them, with their issues and links", async () => {
    renderAt("/");
    const floors = await section("Floors");
    expect(
      await floors.findByRole("heading", { name: "web-shop", level: 3 }),
    ).toBeTruthy();
    const states = await waitFor(() => {
      const shown = within(
        floors.getByRole("list", { name: "web-shop's Agents" }),
      )
        .getAllByTestId("agent-state")
        .map((state) => state.textContent);
      expect(shown).toHaveLength(4);
      expect(shown[1]).not.toBe("Idle");
      return shown;
    });
    expect(states).toEqual([
      "Idle",
      "Working · 2 tasks wait",
      "Idle · paused at a Token Cap · 1 task waits",
      "Idle · paused",
    ]);

    const bo = within(await agentEntry("Bo"));
    expect(bo.getByText("coder · Claude claude-opus-5-5")).toBeTruthy();
    expect(bo.getByRole("link", { name: "#4" }).getAttribute("href")).toBe(
      issueUrl(4),
    );
    expect(
      bo.getByRole("link", { name: "Bo's live view" }).getAttribute("href"),
    ).toBe("/floors/web-shop/agents/bo");
    expect(
      bo.getByRole("link", { name: "Bo's config" }).getAttribute("href"),
    ).toBe("/agent-settings?floor=web-shop&agent=bo");

    const issues = within(
      floors.getByRole("list", { name: "web-shop's issues in progress" }),
    )
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(issues).toEqual([
      "#4WorkWorkingBy BoReview rounds 0 of 3",
      "#7ReviewWaitingPR #12For CyReview rounds 1 of 3",
    ]);
    // An issue's Agent brings its entry into view.
    await userEvent.setup().click(floors.getByRole("link", { name: "Cy" }));
    expect(document.activeElement?.id).toBe(agentEntryId("web-shop", "cy"));

    expect(
      floors
        .getAllByRole("link")
        .filter((link) =>
          [
            "web-shop's Notices",
            "Chat with the Manager",
            "web-shop's settings",
          ].includes(link.getAttribute("aria-label") ?? link.textContent),
        )
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/notices?floorId=web-shop",
      "/floors/web-shop/manager",
      "/floor-settings/web-shop",
    ]);
  });

  it("says how each Floor is doing", async () => {
    renderAt("/");
    const floors = await section("Floors");
    expect(await floors.findByText("Needs you")).toBeTruthy();
    expect(floors.getByText("1 action Notice open.")).toBeTruthy();
  });

  it("reads a Floor again as its events come", async () => {
    renderAt("/");
    await agentEntry("Bo");
    await waitFor(() => {
      expect(screen.getAllByTestId("agent-state")[1]?.textContent).toBe(
        "Working · 2 tasks wait",
      );
    });
    server.board = {
      ...seededBoard(),
      issues: [],
      agents: seededBoard().agents.map((entry) => ({ ...entry, waiting: 0 })),
    };
    act(() => {
      streamFor("agent.queue_changed").send(
        stored(3, {
          type: "agent.queue_changed",
          version: 1,
          floorId: "web-shop",
          agentId: "bo",
          queued: 0,
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("agent-state")[1]?.textContent).toBe(
        "Waiting on review",
      );
    });
  });

  it("reads the Floors again when one changes, such as its name", async () => {
    renderAt("/");
    const floors = await section("Floors");
    await floors.findByRole("heading", { name: "web-shop", level: 3 });
    server.floorName = "Web shop";
    act(() => {
      streamFor("config.changed").send(
        stored(3, {
          type: "config.changed",
          version: 1,
          scope: "floor",
          floorId: "web-shop",
          keys: ["name"],
        }),
      );
    });
    expect(
      await floors.findByRole("heading", { name: "Web shop", level: 3 }),
    ).toBeTruthy();
  });

  it("reaches every settings page", async () => {
    renderAt("/");
    const admin = await section("Settings");
    await admin.findByRole("link", { name: "web-shop: Floor Settings" });
    expect(
      within(admin.getByRole("navigation", { name: "Settings pages" }))
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["General Settings", "/general-settings"],
      ["web-shop: Floor Settings", "/floor-settings/web-shop"],
      ["Gateway requests", "/gateway"],
      ["Analytics", "/analytics"],
    ]);
  });

  it("brings an Agent the address names into view, as its name links there", async () => {
    renderAt("/?floor=web-shop&inspect=agent:cy");
    const cy = await agentEntry("Cy");
    await waitFor(() => {
      expect(document.activeElement).toBe(cy);
    });
    expect(cy.getAttribute("aria-current")).toBe("true");
    expect(scrolled).toHaveBeenCalled();
  });

  it("switches to the 3D Office once the screen is no longer a phone's, and back", async () => {
    renderAt("/");
    await screen.findByTestId("office-2d");
    act(() => {
      display.turn(false);
    });
    expect(await screen.findByTestId("office-3d")).toBeTruthy();
    expect(screen.queryByTestId("office-2d")).toBeNull();
    act(() => {
      display.turn(true);
    });
    expect(await screen.findByTestId("office-2d")).toBeTruthy();
  });
});

describe("the 3D Office elsewhere", () => {
  it("is what a tablet or a desktop gets", async () => {
    display.phone = false;
    renderAt("/");
    expect(await screen.findByTestId("office-3d")).toBeTruthy();
    expect(screen.queryByTestId("office-2d")).toBeNull();
  });
});

describe("what the Office's address names, in 2D", () => {
  const floorAt = { kind: "floor", floorId: "web-shop" } as const;
  it("is an Agent's entry for the Agent or its monitor", () => {
    expect(
      office2dTargetId({ kind: "agent", id: "bo", location: floorAt }),
    ).toBe(agentEntryId("web-shop", "bo"));
    expect(
      office2dTargetId({ kind: "monitor", id: "bo", location: floorAt }),
    ).toBe(agentEntryId("web-shop", "bo"));
  });

  it("is the Floor for its other objects, and the Notice Board for the lobby's", () => {
    for (const kind of ["whiteboard", "wall-board", "bookshelf"] as const) {
      expect(
        office2dTargetId({ kind, id: "web-shop", location: floorAt }),
      ).toBe(floorSectionId("web-shop"));
    }
    expect(
      office2dTargetId({
        kind: "notice-board",
        id: "office",
        location: { kind: "lobby" },
      }),
    ).toBe(office2dSections.notices);
  });
});

describe("an Agent's state in words", () => {
  const board = seededBoard();
  it("is idle, with nothing known of it", () => {
    expect(agentStateText({ id: "zed", enabled: true }, undefined)).toBe(
      "Idle",
    );
  });

  it("waits on review while an issue it handed over is there, unless it works", () => {
    expect(
      agentStateText({ id: "bo", enabled: true }, { ...board, issues: [] }),
    ).toBe("Waiting on review · 2 tasks wait");
  });

  it("works while paused, finishing its task, but never at a Token Cap", () => {
    expect(agentStateText({ id: "bo", enabled: false }, board)).toBe(
      "Working · paused · 2 tasks wait",
    );
    expect(
      agentStateText(
        { id: "cy", enabled: true },
        {
          ...board,
          issues: board.issues.map((issue) => ({
            ...issue,
            status: "working" as const,
          })),
        },
      ),
    ).toBe("Idle · paused at a Token Cap · 1 task waits");
  });
});

function fail(message = "Not found."): never {
  throw new Error(message);
}
