import type { OfficeEvent } from "@ai-office/events/schema";
import type { StreamedEvent } from "@ai-office/events/stream";
import {
  builtInRole,
  defaultCommunicationsAgentAvatar,
  defaultLobbyCast,
  defaultRulesFor,
  noTokens,
  randomAvatar,
  type Agent,
  type AgentContextUsage,
  type CommunicationsAgent,
  type Connection,
  type FloorTheme,
  type FloorTokenUsage,
  type FloorWallBoard,
  type LibraryRole,
  type LobbyCast,
  type Notice,
  type Role,
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
import type { AboveHead, FreshStartSignal } from "./above-head.ts";
import { destination } from "./camera-rig.ts";
import {
  defaultView,
  handView,
  resetCamera,
  useCameraStore,
} from "./camera-store.ts";
import { useFpsStore } from "./fps.ts";
import { liftDestination, liftLocation } from "./lift.ts";
import { liftViewName, resetLift, useLiftStore } from "./lift-store.ts";
import type { AgentLook } from "./agent-state.ts";
import type { FloorGrilling } from "./floor.tsx";
import type { FloorAgent } from "./floor-layout.ts";
import type { FactFindingVisit } from "./grilling-walks.ts";
import type { HandoffTicket } from "./handoff-walks.ts";
import {
  floorInspectables,
  lobbyInspectables,
  type InspectableObject,
} from "./inspectable.ts";
import { openInspectable } from "./inspection.ts";
import type { LiftStop } from "./lift-stops.ts";
import type { MonitorScreen } from "./monitor-preview.ts";
import type { BoardPreview } from "./notice-board-preview.ts";
import { OfficeView, webgl } from "./office-view.tsx";
import { panelLayoutKey } from "./panel-layout.ts";
import { receptionRefreshMs } from "./reception-desk.ts";
import type { Reception } from "./reception-desk.tsx";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { resetSelection, useSelectionStore } from "./selection-store.ts";
import { resetDeskReturn, useDeskReturnStore } from "./desk-return.ts";
import {
  resetMeetingRoomCall,
  useMeetingRoomCall,
} from "./meeting-room-call.ts";

// jsdom has no WebGL, so the canvas is replaced by a stand-in that shows
// what it was given; everything around it is the real thing, against a
// stubbed server.
vi.mock("./office-scene.tsx", () => ({
  OfficeScene: ({
    quality,
    showFps,
    board,
    stops,
    theme,
    team,
    monitors,
    looks,
    needsOwner,
    handoffs,
    grilling,
    factFinding,
    inspectables,
    cast,
    reception,
    aboveHead,
    freshStarts,
  }: {
    quality: string;
    showFps: boolean;
    board: BoardPreview;
    stops: readonly LiftStop[];
    theme?: string | undefined;
    team?: readonly FloorAgent[] | undefined;
    monitors?: ReadonlyMap<string, MonitorScreen> | undefined;
    looks?: ReadonlyMap<string, AgentLook> | undefined;
    needsOwner?: boolean | undefined;
    handoffs?: readonly HandoffTicket[] | undefined;
    grilling?: FloorGrilling | undefined;
    factFinding?: readonly FactFindingVisit[] | undefined;
    inspectables: readonly InspectableObject[];
    cast?: LobbyCast | undefined;
    reception?: Reception | undefined;
    aboveHead?: ReadonlyMap<string, AboveHead> | undefined;
    freshStarts?: readonly FreshStartSignal[] | undefined;
  }) => (
    <div
      data-testid="scene"
      data-quality={quality}
      data-fps={showFps}
      data-cards={board.cards.map(({ id, kind }) => `${id}:${kind}`).join(" ")}
      data-hidden={board.hidden}
      data-stops={stops
        .map(({ name, actionNotices }) => `${name}:${String(actionNotices)}`)
        .join(" ")}
      data-theme={theme ?? "none"}
      data-team={
        team === undefined
          ? "none"
          : team.map(({ id, role }) => `${id}:${role}`).join(" ")
      }
      data-dressings={(team ?? [])
        .map(({ id, deskDressing }) => `${id}:${deskDressing ?? "-"}`)
        .join(" ")}
      data-inspectables={inspectables
        .map(({ kind, id }) => `${kind}:${id}`)
        .join(" ")}
      data-looks={
        looks === undefined
          ? "none"
          : [...looks]
              .map(
                ([id, { animation, marker, tickets }]) =>
                  `${id}:${animation}:${marker ?? "-"}:${String(tickets)}`,
              )
              .join(" ")
      }
      data-needs-owner={String(needsOwner ?? false)}
      data-receptionist={cast?.receptionist.name ?? "none"}
      data-reception={
        reception === undefined
          ? "none"
          : `${String(reception.sent)} sent; failing: ${reception.failing.join(", ")}`
      }
      data-grilling={
        grilling === undefined
          ? "none"
          : `${String(grilling.sessionId)}:${
              grilling.board === undefined
                ? "?"
                : `round ${String(grilling.board.round)} ${grilling.board.questions.join(",")} ${String(grilling.board.decisions)} decisions`
            }`
      }
      data-fact-finding={(factFinding ?? [])
        .map(({ id, agentId }) => `${String(id)}:${agentId}`)
        .join(" ")}
      data-handoffs={
        handoffs === undefined
          ? "none"
          : handoffs
              .map(
                ({ id, issue, stage, fromAgentId, toAgentId }) =>
                  `${String(id)}:${fromAgentId}>${toAgentId}:#${String(issue)}:${stage}`,
              )
              .join(" ")
      }
      data-above-head={
        aboveHead === undefined
          ? "none"
          : [...aboveHead]
              .map(
                ([id, { contextUsage, tokens }]) =>
                  `${id}:${contextUsage === undefined ? "-" : String(contextUsage)}:${
                    tokens === undefined
                      ? "-"
                      : `${String(tokens.today)}/${String(tokens.dailyCap)},${String(tokens.thisMonth)}/${String(tokens.monthlyCap)}`
                  }`,
              )
              .join(" ")
      }
      data-fresh-starts={
        freshStarts === undefined
          ? "none"
          : freshStarts
              .map(
                ({ id, agentId, contextUsage }) =>
                  `${String(id)}:${agentId}:${String(contextUsage)}`,
              )
              .join(" ")
      }
      data-monitors={[...(monitors?.values() ?? [])]
        .map(
          ({ agentId, working, lines }) =>
            `${agentId}:${working ? "on" : "off"}:${String(lines.length)}`,
        )
        .join(" ")}
    />
  ),
}));

const notice = (id: string, overrides: Partial<Notice> = {}): Notice => ({
  id,
  kind: "info",
  title: "PR #3 opened",
  floorId: "blog",
  agentId: null,
  issue: null,
  pullRequest: null,
  ciRunUrl: null,
  actions: [],
  createdAt: "2026-10-08T12:00:00.000Z",
  dismissedAt: null,
  actedAt: null,
  actedOn: null,
  links: [],
  positions: [],
  ...overrides,
});

const floor = (id: string, name: string) => ({
  id,
  name,
  repository: `adrianeyre/${id}`,
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office" as FloorTheme,
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
});

const agent = (floorId: string, id: string, role: Role): Agent => ({
  id,
  floorId,
  name: id,
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

/** The server: its Floors, open Notices, Agents and stored events, which a test may change. */
const server = {
  floors: [floor("web-shop", "Web shop"), floor("blog", "Blog")],
  /** The Role library; none, and the Office keeps the built-in Roles' desks. */
  roles: undefined as LibraryRole[] | undefined,
  notices: [] as Notice[],
  agents: {} as Record<string, Agent[]>,
  boards: {} as Record<string, FloorWallBoard>,
  /** Each Floor's Agents with a session going, and their Context Usage. */
  contextUsage: {} as Record<string, AgentContextUsage[]>,
  /** Each Floor's tokens; none used by default. */
  tokenUsage: {} as Record<string, FloorTokenUsage>,
  events: [] as StreamedEvent[],
  communicationsAgent: undefined as unknown as CommunicationsAgent,
  connections: [] as Connection[],
};

/** A Connection, its latest delivery `delivered` (by its id) if given. */
const connection = (
  id: string,
  name: string,
  {
    delivered,
    failing = false,
  }: { delivered?: string; failing?: boolean } = {},
): Connection => ({
  id,
  name,
  type: "webhook",
  rules: defaultRulesFor("webhook"),
  detailLevel: "titles_and_summaries",
  hint: "…/hook",
  details: [],
  paused: false,
  status: failing ? "failing" : "ok",
  consecutiveFailures: failing ? 5 : 0,
  lastDelivery:
    delivered === undefined
      ? null
      : {
          id: delivered,
          message: {
            kind: "work_complete",
            title: "PR #3 merged",
            floor: null,
            aiOfficeUrl: "http://localhost/",
            githubUrl: null,
            occurredAt: "2026-10-10T09:00:00.000Z",
          },
          test: false,
          status: "delivered",
          attempts: 1,
          createdAt: "2026-10-10T09:00:00.000Z",
          nextAttemptAt: null,
          lastAttemptAt: "2026-10-10T09:00:00.000Z",
          deliveredAt: "2026-10-10T09:00:01.000Z",
          error: null,
        },
  createdAt: "2026-10-10T08:00:00.000Z",
});

/** `GET /api/events`: the stored events its filters match, newest first. */
function storedEvents(url: string) {
  const { searchParams } = new URL(url, "http://localhost");
  const types = searchParams.get("type")?.split(",");
  const matching = server.events
    .filter(
      ({ event }) =>
        (types === undefined || types.includes(event.type)) &&
        ["floorId", "agentId"].every(
          (key) =>
            searchParams.get(key) === null ||
            (event as Record<string, unknown>)[key] === searchParams.get(key),
        ),
    )
    .toSorted((a, b) => b.id - a.id)
    .slice(0, Number(searchParams.get("limit") ?? 50));
  return { events: matching, nextBefore: null };
}

/** An event as the stream sends it: just now, unless said otherwise. */
const storedEvent = (
  id: number,
  event: OfficeEvent,
  occurredAt = new Date().toISOString(),
): StreamedEvent => ({ id, occurredAt, event });

/** A Floor's wall board with nothing in progress. */
const emptyWallBoard = (floorId: string): FloorWallBoard => ({
  floorId,
  roundCap: 3,
  qaRoundCap: 3,
  issues: [],
  queues: [],
  agents: [],
});

/** A Floor's tokens, with none used. */
const emptyTokenUsage = (floorId: string): FloorTokenUsage => ({
  floorId,
  caps: { daily: null, monthly: null },
  agentDefaults: {
    daily: { level: "office", cap: 1_000 },
    monthly: { level: "office", cap: 10_000 },
  },
  usage: { daily: noTokens, monthly: noTokens },
  agents: [],
  issues: [],
});

/** The paths the view fetched. */
let fetched: string[];

/** The live event streams the view opened, newest last. */
let streams: (EventSourceLike & { url: string; send(data: unknown): void })[];

function renderView(
  navigate?: (href: string) => void,
  props: Pick<
    NonNullable<Parameters<typeof OfficeView>[0]>,
    "inspect" | "onInspect"
  > = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OfficeView navigate={navigate} {...props} />
    </QueryClientProvider>,
  );
}

const checked = (element: HTMLElement) => (element as HTMLInputElement).checked;

beforeEach(() => {
  localStorage.clear();
  resetSceneSettings();
  resetCamera();
  resetLift();
  resetSelection();
  resetDeskReturn();
  resetMeetingRoomCall();
  useFpsStore.setState({ reading: undefined });
  server.floors = [floor("web-shop", "Web shop"), floor("blog", "Blog")];
  server.roles = undefined;
  server.notices = [];
  server.agents = {};
  server.boards = {};
  server.contextUsage = {};
  server.tokenUsage = {};
  server.events = [];
  server.communicationsAgent = {
    name: "Grace",
    role: "communications",
    avatar: defaultCommunicationsAgentAvatar,
    aiProvider: "Claude",
    model: "claude-opus-5-5",
    modelOverride: null,
    enabled: true,
    createdAt: "2026-10-08T12:00:00.000Z",
  };
  server.connections = [];
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      const team = /^\/api\/floors\/([^/]+)\/agents$/.exec(url)?.[1];
      const board = /^\/api\/floors\/([^/]+)\/wall-board$/.exec(url)?.[1];
      const usage = /^\/api\/floors\/([^/]+)\/token-usage$/.exec(url)?.[1];
      const context = /^\/api\/floors\/([^/]+)\/context-usage$/.exec(url)?.[1];
      const floorNotices = /^\/api\/notices\?floorId=(.+)$/.exec(url)?.[1];
      return Promise.resolve(
        url === "/api/floors"
          ? Response.json({ floors: server.floors })
          : url === "/api/roles" && server.roles !== undefined
            ? Response.json({ roles: server.roles })
            : url === "/api/notices"
              ? Response.json({ notices: server.notices })
              : floorNotices !== undefined
                ? Response.json({
                    notices: server.notices.filter(
                      ({ floorId }) => floorId === floorNotices,
                    ),
                  })
                : team !== undefined
                  ? Response.json({ agents: server.agents[team] ?? [] })
                  : board !== undefined
                    ? Response.json(
                        server.boards[board] ?? emptyWallBoard(board),
                      )
                    : usage !== undefined
                      ? Response.json(
                          server.tokenUsage[usage] ?? emptyTokenUsage(usage),
                        )
                      : context !== undefined
                        ? Response.json({
                            agents: server.contextUsage[context] ?? [],
                          })
                        : url.startsWith("/api/events?")
                          ? Response.json(storedEvents(url))
                          : url === "/api/communications-agent"
                            ? Response.json(server.communicationsAgent)
                            : url === "/api/connections"
                              ? Response.json({
                                  connections: server.connections,
                                })
                              : url === "/api/office/lobby-cast"
                                ? Response.json(defaultLobbyCast)
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

describe("the Office's 3D view", () => {
  it("says so when the browser has no WebGL 2, and loads no scene", () => {
    vi.spyOn(webgl, "available").mockReturnValue(false);
    renderView();
    expect(screen.getByRole("status").textContent).toContain(
      "This browser cannot show the 3D Office: it has no WebGL 2.",
    );
    expect(screen.queryByTestId("scene")).toBeNull();
    expect(screen.queryByRole("group", { name: "Camera view" })).toBeNull();
  });

  describe("with WebGL", () => {
    beforeEach(() => {
      vi.spyOn(webgl, "available").mockReturnValue(true);
    });

    it("renders the scene, with its panels beside the canvas rather than in it", async () => {
      renderView();
      const scene = await screen.findByTestId("scene");
      expect(scene.dataset["quality"]).toBe("medium");
      const views = screen.getByRole("group", { name: "Camera view" });
      expect(scene.contains(views)).toBe(false);
      expect(views.contains(scene)).toBe(false);
    });

    it("flies the camera to the view picked, and shows where it is going", async () => {
      const user = userEvent.setup();
      renderView();
      const views = screen.getByRole("group", { name: "Camera view" });
      expect(
        within(views)
          .getAllByRole("button")
          .map((button) => [
            button.textContent,
            button.getAttribute("aria-pressed"),
          ]),
      ).toEqual([
        ["Overview", "true"],
        ["Plan", "false"],
        ["Close up", "false"],
        ["Reset view", null],
      ]);

      await user.click(within(views).getByRole("button", { name: "Plan" }));
      expect(destination(useCameraStore.getState().rig)).toBe("plan");
      expect(
        within(views)
          .getByRole("button", { name: "Plan" })
          .getAttribute("aria-pressed"),
      ).toBe("true");

      // From the keyboard too.
      within(views).getByRole("button", { name: "Close up" }).focus();
      await user.keyboard("{Enter}");
      expect(destination(useCameraStore.getState().rig)).toBe("close");
    });

    it("resets the camera to the default view from wherever the mouse left it", async () => {
      const user = userEvent.setup();
      renderView();
      useCameraStore
        .getState()
        .placeByHand({ position: [3, 2, 1], target: [1, 0, 1] });
      expect(destination(useCameraStore.getState().rig)).toBe(handView);

      await user.click(screen.getByRole("button", { name: "Reset view" }));
      expect(destination(useCameraStore.getState().rig)).toBe(defaultView);
    });

    it("changes the quality setting, which the scene is drawn at", async () => {
      const user = userEvent.setup();
      renderView();
      const toggle = screen.getByRole("button", { name: "Scene settings" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("radio", { name: "High" })).toBeNull();

      await user.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const quality = screen.getByRole("group", { name: "Quality" });
      expect(
        within(quality)
          .getAllByRole("radio")
          .map((radio) => (radio as HTMLInputElement).labels?.[0]?.textContent),
      ).toEqual(["Low", "Medium", "High"]);
      expect(checked(screen.getByRole("radio", { name: "Medium" }))).toBe(true);

      await user.click(screen.getByRole("radio", { name: "High" }));
      expect(useSceneSettings.getState().quality).toBe("high");
      expect((await screen.findByTestId("scene")).dataset["quality"]).toBe(
        "high",
      );
    });

    it("turns reduced motion on and off", async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole("button", { name: "Scene settings" }));
      const reduce = screen.getByRole("checkbox", { name: "Reduce motion" });
      expect(checked(reduce)).toBe(false);
      await user.click(reduce);
      expect(useSceneSettings.getState().reducedMotion).toBe(true);
      await user.click(reduce);
      expect(useSceneSettings.getState().reducedMotion).toBe(false);
    });

    it("shows the frame rate over the scene when asked", async () => {
      const user = userEvent.setup();
      renderView();
      expect(screen.queryByLabelText("Frame rate")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Scene settings" }));
      await user.click(
        screen.getByRole("checkbox", { name: "Show frame rate" }),
      );
      expect(useSceneSettings.getState().showFps).toBe(true);
      expect((await screen.findByTestId("scene")).dataset["fps"]).toBe("true");
      expect(screen.getByLabelText("Frame rate").textContent).toContain(
        "Measuring…",
      );

      act(() => {
        useFpsStore.setState({ reading: { fps: 59.6, frameMs: 16.78 } });
      });
      expect(screen.getByLabelText("Frame rate").textContent).toContain(
        "60 fps · 16.8 ms",
      );

      await user.click(
        screen.getByRole("checkbox", { name: "Show frame rate" }),
      );
      expect(screen.queryByLabelText("Frame rate")).toBeNull();
    });

    it("switches the Context Usage bars and token labels above the Agents off and on", async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole("button", { name: "Scene settings" }));
      const above = screen.getByRole("checkbox", {
        name: "Show Context Usage and tokens above Agents",
      });
      expect(checked(above)).toBe(true);
      await user.click(above);
      expect(useSceneSettings.getState().showAboveHead).toBe(false);
      await user.click(above);
      expect(useSceneSettings.getState().showAboveHead).toBe(true);
    });
  });
});

describe("the lobby and the Floors", () => {
  beforeEach(() => {
    vi.spyOn(webgl, "available").mockReturnValue(true);
  });

  /** The scene stand-in once it has what the server sent. */
  const sceneWith = async (attribute: string, value: string) => {
    const scene = await screen.findByTestId("scene");
    await waitFor(() => {
      expect(scene.getAttribute(attribute)).toBe(value);
    });
    return scene;
  };

  const picker = () =>
    within(screen.getByRole("navigation", { name: "Floors" }));

  it("gives the 3D Notice Board the latest open Notices, and says what it shows", async () => {
    server.notices = [
      notice("approve", {
        kind: "action",
        title: "PR #14 awaiting your approval",
        floorId: "web-shop",
        createdAt: "2026-10-08T12:01:00.000Z",
      }),
      notice("opened"),
    ];
    renderView();
    await sceneWith("data-cards", "approve:action opened:info");
    const summary = within(
      screen.getByRole("region", { name: "Notice Board" }),
    );
    expect(
      await summary.findByText(
        "The Notice Board has 1 action Notice and 1 info Notice.",
      ),
    ).toBeDefined();
  });

  it("seats the Communications Agent at reception as the receptionist, in its own name", async () => {
    renderView();
    await sceneWith("data-receptionist", "Grace");
  });

  it("drops an envelope at reception for each message sent, and shows a failing Connection's marker", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // What was sent before the Office opened is not dropped again.
      server.connections = [
        connection("c-1", "Team chat", { delivered: "d-1" }),
        connection("c-2", "Phone"),
      ];
      renderView();
      await sceneWith("data-reception", "0 sent; failing: ");

      server.connections = [
        connection("c-1", "Team chat", { delivered: "d-2" }),
        connection("c-2", "Phone", { delivered: "d-3", failing: true }),
      ];
      await act(() => vi.advanceTimersByTimeAsync(receptionRefreshMs));
      await sceneWith("data-reception", "2 sent; failing: Phone");

      // Read again with nothing new: nothing more dropped.
      await act(() => vi.advanceTimersByTimeAsync(receptionRefreshMs));
      await sceneWith("data-reception", "2 sent; failing: Phone");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the Connections in the lobby only", async () => {
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
    renderView();
    await sceneWith("data-team", "");
    expect(screen.getByTestId("scene").dataset["reception"]).toBe("none");
    expect(fetched).not.toContain("/api/connections");
  });

  it("pins up only the latest six, as the Notices change live", async () => {
    renderView();
    const scene = await sceneWith("data-cards", "");
    expect(
      await screen.findByText(
        "The Notice Board is empty: nothing needs you right now.",
      ),
    ).toBeDefined();

    server.notices = Array.from({ length: 8 }, (_, index) =>
      notice(`notice-${String(index + 1)}`, {
        createdAt: new Date(Date.UTC(2026, 9, 8, 12, index)).toISOString(),
      }),
    );
    const stream = streams.find(Boolean);
    act(() => {
      stream?.send({
        id: 1,
        occurredAt: "2026-10-08T12:08:00.000Z",
        event: {
          type: "notice.raised",
          version: 1,
          noticeId: "notice-8",
          kind: "info",
          title: "PR #3 opened",
          floorId: "blog",
        },
      });
    });
    await sceneWith(
      "data-cards",
      "notice-8:info notice-7:info notice-6:info notice-5:info notice-4:info notice-3:info",
    );
    expect(scene.dataset["hidden"]).toBe("2");
    expect(
      screen.getByText(
        "The Notice Board has 8 info Notices; the latest 6 are pinned up.",
      ),
    ).toBeDefined();
  });

  it("opens the 2D Notice Board from the lobby, without a reload", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    renderView(navigate);
    const link = await screen.findByRole("link", {
      name: "Open the Notice Board",
    });
    expect(link.getAttribute("href")).toBe("/notices");
    await user.click(link);
    expect(navigate).toHaveBeenCalledWith("/notices");
  });

  it("lists the lobby and every Floor in the lift's floor picker, with their action Notices", async () => {
    server.notices = [
      notice("1", { kind: "action", floorId: "web-shop" }),
      notice("2", { kind: "action", floorId: "web-shop" }),
      notice("3", { kind: "info", floorId: "blog" }),
    ];
    renderView();
    await sceneWith("data-stops", "Lobby:0 Web shop:2 Blog:0");
    const buttons = picker().getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Lobby",
      "Web shop2, 2 action Notices",
      "Blog",
    ]);
    // The indicator is a count with a bell and words, not only a colour.
    const webShop = picker().getByRole("button", {
      name: "Web shop, 2 action Notices",
    });
    expect(webShop.querySelector("svg")).not.toBeNull();
    expect(webShop.getAttribute("title")).toBe("adrianeyre/web-shop");
    // The lobby is where the Owner is.
    expect(
      picker()
        .getByRole("button", { name: "Lobby" })
        .getAttribute("aria-current"),
    ).toBe("location");
    expect(picker().getByRole("status").textContent).toBe("You are in Lobby.");
  });

  it("shows a Floor's new name in the lift's floor picker as soon as it is renamed (PRD FR-7)", async () => {
    renderView();
    await sceneWith("data-stops", "Lobby:0 Web shop:0 Blog:0");
    server.floors = [floor("web-shop", "Storefront"), floor("blog", "Blog")];
    const stream = streams.find(({ url }) => url.includes("floor.renamed"));
    expect(stream).toBeDefined();
    act(() => {
      stream?.send(
        storedEvent(20, {
          type: "floor.renamed",
          version: 1,
          floorId: "web-shop",
          name: "Storefront",
          previousName: "Web shop",
        }),
      );
    });
    await sceneWith("data-stops", "Lobby:0 Storefront:0 Blog:0");
    // Its repository is still its tooltip.
    expect(
      picker()
        .getByRole("button", { name: "Storefront" })
        .getAttribute("title"),
    ).toBe("adrianeyre/web-shop");
  });

  it("rides the lift to the Floor picked, then shows it", async () => {
    const user = userEvent.setup();
    renderView();
    await sceneWith("data-stops", "Lobby:0 Web shop:0 Blog:0");
    await user.click(picker().getByRole("button", { name: "Web shop" }));

    // The camera goes to the lift doors to watch them close.
    expect(destination(useCameraStore.getState().rig)).toBe(liftViewName);
    expect(picker().getByRole("status").textContent).toBe("Going to Web shop…");
    // Still the lobby until the car arrives.
    expect(screen.getByRole("region", { name: "Notice Board" })).toBeDefined();

    act(() => {
      useLiftStore.getState().advance(10, false);
    });
    expect(liftLocation(useLiftStore.getState().lift)).toEqual({
      kind: "floor",
      floorId: "web-shop",
    });
    expect(destination(useCameraStore.getState().rig)).toBe(defaultView);
    expect(picker().getByRole("status").textContent).toBe(
      "You are in Web shop.",
    );
    expect(
      picker()
        .getByRole("button", { name: "Web shop" })
        .getAttribute("aria-current"),
    ).toBe("location");
    // The lobby's Notice Board summary is the lobby's only.
    expect(screen.queryByRole("region", { name: "Notice Board" })).toBeNull();

    // And back down, from the keyboard.
    picker().getByRole("button", { name: "Lobby" }).focus();
    await user.keyboard("{Enter}");
    act(() => {
      useLiftStore.getState().advance(10, false);
    });
    expect(liftLocation(useLiftStore.getState().lift)).toEqual({
      kind: "lobby",
    });
  });

  it("hides and shows the floor picker with the Lift button", async () => {
    const user = userEvent.setup();
    renderView();
    const toggle = screen.getByRole("button", { name: "Lift" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("navigation", { name: "Floors" })).toBeNull();
    // Clicking the lift in the scene opens it again.
    act(() => {
      useLiftStore.getState().setPickerOpen(true);
    });
    expect(screen.getByRole("navigation", { name: "Floors" })).toBeDefined();
  });

  it("goes back to the lobby when the Floor it shows is archived", async () => {
    useLiftStore.getState().call({
      order: 2,
      location: { kind: "floor", floorId: "blog" },
    });
    useLiftStore.getState().advance(10, true);
    server.floors = [floor("web-shop", "Web shop")];
    renderView();
    await sceneWith("data-stops", "Lobby:0 Web shop:0");
    await waitFor(() => {
      expect(picker().getByRole("status").textContent).toBe("Going to Lobby…");
    });
  });

  it("gives a Floor's desks its Agents, and keeps them as Agents join", async () => {
    server.agents["web-shop"] = [
      agent("web-shop", "ada", "manager"),
      agent("web-shop", "bo", "coder"),
    ];
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
    renderView();
    await sceneWith("data-team", "ada:manager bo:coder");

    server.agents["web-shop"].push(agent("web-shop", "cy", "qa"));
    const stream = streams.find(({ url }) => url.includes("agent.created"));
    expect(stream?.url).toContain("floorId=web-shop");
    act(() => {
      stream?.send({
        id: 2,
        occurredAt: "2026-10-08T12:09:00.000Z",
        event: {
          type: "agent.created",
          version: 1,
          floorId: "web-shop",
          agentId: "cy",
          name: "cy",
          role: "qa",
          aiProvider: "Claude",
          model: "claude-opus-5-5",
        },
      });
    });
    await sceneWith("data-team", "ada:manager bo:coder cy:qa");
  });

  it("dresses a Floor in its theme, and each desk as the Role library dresses its Role", async () => {
    server.floors = [
      { ...floor("web-shop", "Web shop"), theme: "stockroom" },
      floor("blog", "Blog"),
    ];
    const libraryRole = (
      id: string,
      deskDressing: LibraryRole["deskDressing"],
    ): LibraryRole => ({
      id,
      name: id,
      stage: "work",
      description: `Does a ${id}'s work.`,
      instructions: "",
      skills: [],
      deskDressing,
      aiProvider: null,
      model: null,
      agents: 1,
      inStartingTeam: true,
    });
    server.roles = [
      libraryRole("merchandiser", "product-samples"),
      libraryRole("copywriter", "notebooks"),
    ];
    server.agents["web-shop"] = [
      agent("web-shop", "ada", "manager"),
      agent("web-shop", "mo", "merchandiser"),
      agent("web-shop", "cy", "copywriter"),
    ];
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
    renderView();
    await sceneWith("data-theme", "stockroom");
    await sceneWith("data-dressings", "ada:- mo:product-samples cy:notebooks");

    // Another Floor is dressed in its own.
    useLiftStore.getState().call({
      order: 2,
      location: { kind: "floor", floorId: "blog" },
    });
    act(() => {
      useLiftStore.getState().advance(10, true);
    });
    await sceneWith("data-theme", "office");
  });

  it("gives a Floor's wall board only that Floor's Notices", async () => {
    server.notices = [
      notice("shop-action", {
        kind: "action",
        floorId: "web-shop",
        createdAt: "2026-10-08T12:02:00.000Z",
      }),
      notice("blog-info", { floorId: "blog" }),
      notice("office-info", { floorId: null }),
      notice("shop-info", { floorId: "web-shop" }),
    ];
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
    renderView();
    await sceneWith("data-cards", "shop-action:action shop-info:info");
  });

  it("asks for no Agents in the lobby", async () => {
    renderView();
    await sceneWith("data-stops", "Lobby:0 Web shop:0 Blog:0");
    expect(screen.getByTestId("scene").dataset["team"]).toBe("none");
    expect(screen.getByTestId("scene").dataset["theme"]).toBe("none");
    expect(fetched.some((url) => url.includes("/agents"))).toBe(false);
    expect(fetched).not.toContain("/api/roles");
  });
});

/** An Agent's status on the web-shop Floor. */
const statusEvent = (
  id: number,
  agentId: string,
  status: "working" | "idle",
): StreamedEvent =>
  storedEvent(id, {
    type: "agent.status_changed",
    version: 1,
    floorId: "web-shop",
    agentId,
    status,
    ...(status === "idle" ? {} : { issue: 4 }),
  });

/** What an Agent on the web-shop Floor says in its sandbox. */
const said = (id: number, agentId: string, text: string): StreamedEvent =>
  storedEvent(id, {
    type: "sandbox.text",
    version: 1,
    floorId: "web-shop",
    agentId,
    issue: 4,
    sandboxId: `sbx-${agentId}`,
    text,
  });

describe("the desks' monitors", () => {
  beforeEach(() => {
    vi.spyOn(webgl, "available").mockReturnValue(true);
    server.agents["web-shop"] = [
      agent("web-shop", "ada", "manager"),
      agent("web-shop", "bo", "coder"),
      agent("web-shop", "cy", "reviewer"),
    ];
  });

  const atWebShop = () => {
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
  };

  const sceneWithMonitors = async (monitors: string) => {
    const scene = await screen.findByTestId("scene");
    await waitFor(() => {
      expect(scene.dataset["monitors"]).toBe(monitors);
    });
  };

  const params = (url: string) => new URL(url, "http://localhost").searchParams;

  it("light up a working Agent's monitor from the Floor's latest events, then follow them live", async () => {
    server.events = [
      statusEvent(1, "bo", "working"),
      said(2, "bo", "Running the tests.\n12 passed"),
      statusEvent(3, "cy", "working"),
      statusEvent(4, "cy", "idle"),
      said(5, "ada", "Planning"),
    ];
    atWebShop();
    renderView();
    // The coder is working, with its two lines; the others are not.
    await sceneWithMonitors("ada:off:1 bo:on:2 cy:off:0");

    // The statuses and the activity are read apart, a page of each.
    const reads = fetched
      .filter((url) => url.startsWith("/api/events?"))
      .map(params);
    expect(
      reads.map((read) => [
        read.get("floorId"),
        read.get("type"),
        read.get("limit"),
      ]),
    ).toEqual([
      ["web-shop", "agent.status_changed,sandbox.started", "200"],
      [
        "web-shop",
        "sandbox.text,sandbox.tool_call,sandbox.diff,model_call.completed",
        "200",
      ],
    ]);

    // Then the Floor's stream, resuming after the older page's newest.
    const stream = streams.find(({ url }) => url.includes("sandbox.text"));
    expect(stream).toBeDefined();
    expect(params(stream?.url ?? "").get("floorId")).toBe("web-shop");
    expect(params(stream?.url ?? "").get("lastEventId")).toBe("4");
    act(() => {
      // A repeat is read once.
      stream?.send(said(5, "ada", "Planning"));
      stream?.send(statusEvent(6, "cy", "working"));
      stream?.send(said(7, "cy", "Reading the diff"));
    });
    await sceneWithMonitors("ada:off:1 bo:on:2 cy:on:1");
    act(() => {
      stream?.send(statusEvent(8, "bo", "idle"));
    });
    await sceneWithMonitors("ada:off:1 bo:off:2 cy:on:1");
  });

  it("never lose one Agent's status under another's output", async () => {
    server.events = [
      statusEvent(1, "bo", "working"),
      ...Array.from({ length: 250 }, (_, index) =>
        said(index + 2, "cy", `line ${String(index)}`),
      ),
    ];
    atWebShop();
    renderView();
    await sceneWithMonitors("ada:off:0 bo:on:0 cy:off:16");
  });

  it("read nothing in the lobby", async () => {
    renderView();
    await sceneWithMonitors("");
    expect(fetched.some((url) => url.startsWith("/api/events"))).toBe(false);
    expect(streams.some(({ url }) => url.includes("sandbox.text"))).toBe(false);
  });
});

describe("what the Agents' states look like", () => {
  beforeEach(() => {
    vi.spyOn(webgl, "available").mockReturnValue(true);
    server.agents["web-shop"] = [
      agent("web-shop", "ada", "manager"),
      agent("web-shop", "bo", "coder"),
      { ...agent("web-shop", "cy", "reviewer"), enabled: false },
      agent("web-shop", "di", "qa"),
    ];
    server.boards["web-shop"] = {
      ...emptyWallBoard("web-shop"),
      agents: [
        { agentId: "ada", waiting: 0, awaitingReview: [], capped: false },
        { agentId: "bo", waiting: 2, awaitingReview: [7], capped: false },
        { agentId: "cy", waiting: 0, awaitingReview: [], capped: false },
        { agentId: "di", waiting: 14, awaitingReview: [], capped: true },
      ],
    };
  });

  const atWebShop = () => {
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
  };

  const sceneWithLooks = async (looks: string) => {
    const scene = await screen.findByTestId("scene");
    await waitFor(() => {
      expect(scene.dataset["looks"]).toBe(looks);
    });
  };

  it("gives the scene each Agent's state, from its monitor, its pause and the Floor's wall board", async () => {
    server.events = [statusEvent(1, "ada", "working")];
    atWebShop();
    renderView();
    // The Manager types; the coder waits on review with two tickets; the
    // paused reviewer has a pause marker; QA, at its Token Cap, a cap
    // marker and a full pile.
    await sceneWithLooks(
      "ada:type:-:0 bo:wait:-:2 cy:sit:paused:0 di:sit:capped:10",
    );
  });

  it("reads the wall board again as an Agent's state changes, on the team's own stream", async () => {
    atWebShop();
    renderView();
    await sceneWithLooks(
      "ada:sit:-:0 bo:wait:-:2 cy:sit:paused:0 di:sit:capped:10",
    );
    // The coder's issue passes review, and more work waits for it.
    server.boards["web-shop"] = {
      ...emptyWallBoard("web-shop"),
      agents: [
        { agentId: "bo", waiting: 3, awaitingReview: [], capped: false },
        { agentId: "di", waiting: 14, awaitingReview: [], capped: false },
      ],
    };
    const stream = streams.find(({ url }) => url.includes("agent.created"));
    for (const type of [
      "agent.queue_changed",
      "agent.status_changed",
      "issue.label_changed",
    ]) {
      expect(stream?.url).toContain(type);
    }
    act(() => {
      stream?.send(
        storedEvent(9, {
          type: "agent.queue_changed",
          version: 1,
          floorId: "web-shop",
          agentId: "bo",
          queued: 3,
        }),
      );
    });
    await sceneWithLooks("ada:sit:-:0 bo:sit:-:3 cy:sit:paused:0 di:sit:-:10");
    // No stream of its own: the team's carries it.
    expect(
      streams.filter(({ url }) => url.includes("agent.queue_changed")),
    ).toHaveLength(1);
  });

  it("lights the Manager's red light while the Floor has an action Notice", async () => {
    server.notices = [
      notice("blog-action", { kind: "action", floorId: "blog" }),
      notice("shop-info", { floorId: "web-shop" }),
    ];
    atWebShop();
    renderView();
    const scene = await screen.findByTestId("scene");
    await sceneWithLooks(
      "ada:sit:-:0 bo:wait:-:2 cy:sit:paused:0 di:sit:capped:10",
    );
    expect(scene.dataset["needsOwner"]).toBe("false");
    // An action Notice on this Floor arrives, live.
    server.notices = [
      ...server.notices,
      notice("shop-action", { kind: "action", floorId: "web-shop" }),
    ];
    const noticeStream = streams.find(({ url }) =>
      url.includes("notice.raised"),
    );
    act(() => {
      noticeStream?.send(
        storedEvent(10, {
          type: "notice.raised",
          version: 1,
          noticeId: "shop-action",
          kind: "action",
          title: "PR #14 awaiting your approval",
          floorId: "web-shop",
        }),
      );
    });
    await waitFor(() => {
      expect(scene.dataset["needsOwner"]).toBe("true");
    });
  });

  it("gives the scene each Handoff on the Floor as it comes, on the team's own stream", async () => {
    atWebShop();
    renderView();
    const scene = await screen.findByTestId("scene");
    await waitFor(() => {
      expect(scene.dataset["handoffs"]).toBe("");
    });
    const stream = streams.find(({ url }) => url.includes("agent.created"));
    expect(stream?.url).toContain("handoff");
    act(() => {
      stream?.send(
        storedEvent(12, {
          type: "handoff",
          version: 1,
          floorId: "web-shop",
          issue: 14,
          fromAgentId: "bo",
          toAgentId: "cy",
          stage: "needs-review",
          summary: { changed: "the cart", check: "totals", risks: "none" },
        }),
      );
    });
    await waitFor(() => {
      expect(scene.dataset["handoffs"]).toBe("12:bo>cy:#14:needs-review");
    });
    // No stream of its own: the team's carries it.
    expect(
      streams.filter(({ url }) =>
        new URL(url, "http://localhost").searchParams
          .get("type")
          ?.split(",")
          .includes("handoff"),
      ),
    ).toHaveLength(1);
  });

  it("never walks a Handoff that happened before the Floor was shown, such as one the stream brings back on a return to it", async () => {
    atWebShop();
    renderView();
    const scene = await screen.findByTestId("scene");
    await waitFor(() => {
      expect(scene.dataset["handoffs"]).toBe("");
    });
    const stream = streams.find(({ url }) => url.includes("agent.created"));
    const handoff = (id: number, occurredAt?: string) =>
      storedEvent(
        id,
        {
          type: "handoff",
          version: 1,
          floorId: "web-shop",
          issue: id,
          fromAgentId: "bo",
          toAgentId: "cy",
          stage: "needs-review",
          summary: { changed: "the cart", check: "totals", risks: "none" },
        },
        occurredAt,
      );
    act(() => {
      // Ten minutes ago, while the Owner was elsewhere; then one now.
      stream?.send(
        handoff(12, new Date(Date.now() - 10 * 60_000).toISOString()),
      );
      stream?.send(handoff(13));
    });
    await waitFor(() => {
      expect(scene.dataset["handoffs"]).toBe("13:bo>cy:#13:needs-review");
    });
  });

  it("shows no states in the lobby, nor reads a wall board there", async () => {
    server.notices = [
      notice("shop-action", { kind: "action", floorId: "web-shop" }),
    ];
    renderView();
    const scene = await screen.findByTestId("scene");
    await waitFor(() => {
      expect(scene.dataset["stops"]).toBe("Lobby:0 Web shop:1 Blog:0");
    });
    expect(scene.dataset["looks"]).toBe("none");
    expect(scene.dataset["handoffs"]).toBe("none");
    expect(scene.dataset["needsOwner"]).toBe("false");
    expect(fetched.some((url) => url.includes("/wall-board"))).toBe(false);
  });
});

describe("what floats above the Agents' heads", () => {
  beforeEach(() => {
    vi.spyOn(webgl, "available").mockReturnValue(true);
    server.agents["web-shop"] = [
      agent("web-shop", "ada", "coder"),
      agent("web-shop", "di", "designer"),
    ];
    server.contextUsage["web-shop"] = [
      {
        agentId: "ada",
        floorId: "web-shop",
        issue: 4,
        model: "claude-opus-5-5",
        inputTokens: 124_000,
        contextWindow: 200_000,
        contextUsage: 0.62,
        updatedAt: "2026-10-10T09:00:00.000Z",
      },
    ];
    server.tokenUsage["web-shop"] = {
      ...emptyTokenUsage("web-shop"),
      agents: [
        {
          agentId: "ada",
          usage: { daily: noTokens, monthly: noTokens },
          caps: {
            daily: { level: "office", cap: 1_000_000, used: 128_000 },
            monthly: { level: "office", cap: 10_000_000, used: 3_400_000 },
          },
        },
        {
          agentId: "di",
          usage: { daily: noTokens, monthly: noTokens },
          caps: {
            daily: { level: "agent", cap: 1_000_000, used: 850_000 },
            monthly: { level: "office", cap: 10_000_000, used: 900_000 },
          },
        },
      ],
    };
  });

  const atWebShop = () => {
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
  };

  const sceneWith = async (attribute: string, value: string) => {
    const scene = await screen.findByTestId("scene");
    await waitFor(() => {
      expect(scene.getAttribute(attribute)).toBe(value);
    });
    return scene;
  };

  it("gives the scene each Agent's Context Usage and tokens, and follows Context Usage and Fresh Starts live, on a stream of their own", async () => {
    atWebShop();
    renderView();
    // The coder is busy: a bar and its tokens. The designer is idle: its
    // tokens only.
    await sceneWith(
      "data-above-head",
      "ada:0.62:128000/1000000,3400000/10000000 di:-:850000/1000000,900000/10000000",
    );
    const stream = streams.find(({ url }) =>
      url.includes("agent.context_usage"),
    );
    expect(stream?.url).toContain("agent.fresh_start");
    expect(stream?.url).not.toContain("handoff");
    act(() => {
      stream?.send(
        storedEvent(20, {
          type: "agent.context_usage",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          issue: 4,
          active: true,
          model: "claude-opus-5-5",
          inputTokens: 172_000,
          contextWindow: 200_000,
          contextUsage: 0.86,
        }),
      );
    });
    await sceneWith(
      "data-above-head",
      "ada:0.86:128000/1000000,3400000/10000000 di:-:850000/1000000,900000/10000000",
    );
    // A Fresh Start: the session ends, and the bar empties.
    act(() => {
      stream?.send(
        storedEvent(21, {
          type: "agent.fresh_start",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          issue: 4,
          trigger: "threshold",
          contextUsage: 0.86,
        }),
      );
      stream?.send(
        storedEvent(22, {
          type: "agent.context_usage",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          active: false,
          contextUsage: null,
        }),
      );
    });
    await sceneWith("data-fresh-starts", "21:ada:0.86");
    await sceneWith(
      "data-above-head",
      "ada:-:128000/1000000,3400000/10000000 di:-:850000/1000000,900000/10000000",
    );
    // The team's stream carries none of it, nor reads the wall board for it.
    expect(
      streams.filter(({ url }) => url.includes("agent.context_usage")),
    ).toHaveLength(1);
    expect(
      streams.find(({ url }) => url.includes("agent.created"))?.url,
    ).not.toContain("agent.context_usage");
  });

  it("reads and shows none of it while the scene settings switch it off", async () => {
    useSceneSettings.getState().setShowAboveHead(false);
    atWebShop();
    renderView();
    await sceneWith("data-team", "ada:coder di:designer");
    const scene = await screen.findByTestId("scene");
    expect(scene.dataset["aboveHead"]).toBe("none");
    expect(scene.dataset["freshStarts"]).toBe("none");
    expect(fetched.some((url) => url.includes("/context-usage"))).toBe(false);
    expect(fetched.some((url) => url.includes("/token-usage"))).toBe(false);
    expect(streams.some(({ url }) => url.includes("agent.context_usage"))).toBe(
      false,
    );

    act(() => {
      useSceneSettings.getState().setShowAboveHead(true);
    });
    await sceneWith(
      "data-above-head",
      "ada:0.62:128000/1000000,3400000/10000000 di:-:850000/1000000,900000/10000000",
    );
  });

  it("shows none in the lobby, nor reads it there", async () => {
    renderView();
    const scene = await sceneWith("data-stops", "Lobby:0 Web shop:0 Blog:0");
    expect(scene.dataset["aboveHead"]).toBe("none");
    expect(fetched.some((url) => url.includes("/context-usage"))).toBe(false);
    expect(fetched.some((url) => url.includes("/token-usage"))).toBe(false);
  });
});

describe("inspectable objects", () => {
  beforeEach(() => {
    vi.spyOn(webgl, "available").mockReturnValue(true);
    server.agents["web-shop"] = [
      agent("web-shop", "ada", "manager"),
      agent("web-shop", "bo", "coder"),
    ];
  });

  /** Put the lift at the web-shop Floor, before the view is shown. */
  const atWebShop = () => {
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
  };

  /** The web-shop Floor's objects, as the view lays them out. */
  const webShop = () =>
    floorInspectables("web-shop", server.agents["web-shop"] ?? []);

  /** The scene stand-in once it has the objects the view gave it. */
  const sceneWithObjects = async (objects: string) => {
    const scene = await screen.findByTestId("scene");
    await waitFor(() => {
      expect(scene.dataset["inspectables"]).toBe(objects);
    });
  };

  const lobbyObjects = "notice-board:office agent:communications";

  const floorObjects =
    "whiteboard:web-shop wall-board:web-shop bookshelf:web-shop skills-bookshelf:web-shop monitor:ada monitor:bo agent:ada agent:bo";

  /** The keyboard list of the objects, opened with its button. */
  const openList = async (user: ReturnType<typeof userEvent.setup>) => {
    const toggle = screen.getByRole("button", { name: "Inspect" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    return within(
      screen.getByRole("navigation", { name: "Objects to inspect" }),
    );
  };

  /** The open panel: its type, its heading, and what it says and links to. */
  const panel = () => {
    const dialog = screen.getByRole("dialog");
    return {
      kind: dialog.dataset["kind"],
      // Its own heading; a panel's body may have headings of its own.
      name: within(dialog).getByRole("heading", { level: 2 }).textContent,
      text: dialog.textContent,
      links: within(dialog)
        .queryAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    };
  };

  const headingTo = () => destination(useCameraStore.getState().rig);

  it("lists every object where the lift is, and gives the scene the same", async () => {
    const user = userEvent.setup();
    renderView();
    await sceneWithObjects(lobbyObjects);
    const list = await openList(user);
    expect(
      list.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["The Notice Board", "Grace"]);
    cleanup();

    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    const floorList = await openList(user);
    expect(
      floorList.getAllByRole("button").map((button) => button.textContent),
    ).toEqual([
      "The whiteboard",
      "The wall board",
      "The bookshelf",
      "The Manager's bookshelf",
      "ada's monitor",
      "bo's monitor",
      "ada",
      "bo",
    ]);
  });

  it("opens the right panel for each type of object selected in the scene", async () => {
    const navigate = vi.fn();
    atWebShop();
    renderView(navigate);
    await sceneWithObjects(floorObjects);
    expect(screen.queryByRole("dialog")).toBeNull();

    const expected = {
      "whiteboard:web-shop": {
        kind: "whiteboard",
        name: "The whiteboard",
        // Its own panel: the Floor's Plans (#84), and their page.
        says: "Plans",
        links: [
          [
            "Open the whiteboard on its own page",
            "/floors/web-shop/whiteboard",
          ],
        ],
      },
      "wall-board:web-shop": {
        kind: "wall-board",
        name: "The wall board",
        says: "In progress",
        links: [["Open this Floor's Notices", "/notices?floorId=web-shop"]],
      },
      "bookshelf:web-shop": {
        kind: "bookshelf",
        name: "The bookshelf",
        // Its own panel: the Floor's memory (#89), and where to edit it.
        says: "The repository's memory",
        links: [
          [
            "Edit the Role memory",
            "/agent-settings?floor=web-shop#role-memory",
          ],
          [
            "Edit the office-wide memory",
            "/general-settings#office-wide-memory",
          ],
        ],
      },
      "skills-bookshelf:web-shop": {
        kind: "skills-bookshelf",
        name: "The Manager's bookshelf",
        // Its own panel: the Floor's Available Skills (#92).
        says: "The Skills this Floor's Manager can run",
        links: [["Open the Manager chat", "/floors/web-shop/manager"]],
      },
      "monitor:ada": {
        kind: "monitor",
        name: "ada's monitor",
        says: "live activity",
        links: [["Open the live view", "/floors/web-shop/agents/ada"]],
      },
      "monitor:bo": {
        kind: "monitor",
        name: "bo's monitor",
        says: "live activity",
        links: [["Open the live view", "/floors/web-shop/agents/bo"]],
      },
      "agent:ada": {
        kind: "agent",
        name: "ada",
        says: "Current issue",
        links: [
          ["Open ada's config", "/agent-settings?floor=web-shop&agent=ada"],
        ],
      },
      "agent:bo": {
        kind: "agent",
        name: "bo",
        says: "Current issue",
        links: [
          ["Open bo's config", "/agent-settings?floor=web-shop&agent=bo"],
        ],
      },
    } as const;
    for (const object of webShop()) {
      // What a click on it in the scene does (inspectable-hotspots.tsx).
      act(() => {
        openInspectable(object);
      });
      const want =
        expected[`${object.kind}:${object.id}` as keyof typeof expected];
      const shown = panel();
      expect(shown.kind).toBe(want.kind);
      expect(shown.name).toBe(want.name);
      expect(shown.text).toContain(want.says);
      expect(shown.links).toEqual(want.links);
      expect(headingTo()).toBe(`inspect:${object.kind}:${object.id}`);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    }

    // Its links open their 2D pages without a reload.
    await userEvent
      .setup()
      .click(screen.getByRole("link", { name: "Open bo's config" }));
    expect(navigate).toHaveBeenCalledWith(
      "/agent-settings?floor=web-shop&agent=bo",
    );
  });

  it("opens the Manager chat from its button over a Floor's scene, flying to the Manager", async () => {
    const user = userEvent.setup();
    renderView();
    await sceneWithObjects(lobbyObjects);
    expect(
      screen.queryByRole("button", { name: "Chat with the Manager" }),
    ).toBeNull();
    cleanup();

    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    await user.click(
      await screen.findByRole("button", { name: "Chat with the Manager" }),
    );
    const shown = panel();
    expect(shown.kind).toBe("agent");
    expect(shown.name).toBe("ada");
    expect(shown.text).toContain("Back to ada's card");
    expect(shown.links).toEqual([
      ["Open the Manager chat", "/floors/web-shop/manager"],
    ]);
    expect(headingTo()).toBe("inspect:agent:ada");
    // Not over the chat it opened.
    expect(
      screen.queryByRole("button", { name: "Chat with the Manager" }),
    ).toBeNull();

    // Back on the card, the request is spent: it stays the card.
    await user.click(
      screen.getByRole("button", { name: "Back to ada's card" }),
    );
    expect(panel().text).toContain("Current issue");
  });

  /**
   * A Floor's Grilling Sessions, kept by a stand-in server: the Manager
   * chat's messages start one ("/grilling") or resume one ("resume
   * session 3"), as the Manager chat does.
   */
  const planningServer = (
    sessions: { id: number; status: "active" | "paused" | "ended" }[],
  ) => {
    const summary = ({
      id,
      status,
    }: {
      id: number;
      status: "active" | "paused" | "ended";
    }) => ({
      id,
      floorId: "web-shop",
      topic: "",
      status,
      round: 0,
      awaitingConfirmation: false,
      openQuestions: 0,
      decisionCount: 0,
      startedAt: "2026-10-09T12:00:00.000Z",
      updatedAt: "2026-10-09T12:00:00.000Z",
      pausedAt: status === "paused" ? "2026-10-09T12:10:00.000Z" : null,
      endedAt: null,
    });
    const posts: { text: unknown; csrf: string | null }[] = [];
    const stop: {
      at: string | null;
      posts: { url: string; csrf: string | null }[];
    } = { at: null, posts: [] };
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/floors/web-shop/grilling-sessions") {
        return Promise.resolve(
          Response.json({ sessions: sessions.map(summary) }),
        );
      }
      if (url === "/api/floors/web-shop/stop" && init?.method !== "POST") {
        return Promise.resolve(Response.json({ stoppedAt: stop.at }));
      }
      if (
        (url === "/api/floors/web-shop/stop" ||
          url === "/api/floors/web-shop/continue") &&
        init?.method === "POST"
      ) {
        stop.at = url.endsWith("/stop") ? "2026-10-09T13:00:00.000Z" : null;
        stop.posts.push({
          url,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        return Promise.resolve(Response.json({ stoppedAt: stop.at }));
      }
      if (url.startsWith("/api/floors/web-shop/manager-chat/files")) {
        const query = new URL(url, "http://office").searchParams.get("query");
        return Promise.resolve(
          Response.json({
            files:
              query === "docs/product-requirements-document/"
                ? ["docs/product-requirements-document/exports.md"]
                : [],
          }),
        );
      }
      const detail = /grilling-sessions\/(\d+)$/.exec(url)?.[1];
      const found = sessions.find(({ id }) => String(id) === detail);
      if (found !== undefined) {
        return Promise.resolve(
          Response.json({
            session: {
              ...summary(found),
              questions: [],
              decisions: [],
              terms: [],
              facts: [],
              outline: [],
              adrs: [],
              processes: [],
              documents: null,
              issues: null,
            },
            messages: [],
          }),
        );
      }
      if (url === "/api/floors/web-shop/manager-chat") {
        return Promise.resolve(
          Response.json({
            manager: {
              id: "ada",
              name: "ada",
              aiProvider: "Claude",
              model: "claude-opus-5-5",
            },
            messages: [],
            pending: [],
          }),
        );
      }
      if (
        url === "/api/floors/web-shop/manager-chat/messages" &&
        init?.method === "POST"
      ) {
        const { text } = JSON.parse(init.body as string) as { text: string };
        posts.push({
          text,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        let sessionId = sessions.find(({ status }) => status === "active")?.id;
        if (
          /^\/(?:grilling|grill-with-docs|wayfinder|to-tickets)\b/.test(text) &&
          sessionId === undefined
        ) {
          sessionId = Math.max(0, ...sessions.map(({ id }) => id)) + 1;
          sessions.unshift({ id: sessionId, status: "active" });
        }
        if (text === "pause the session") {
          const active = sessions.find(({ status }) => status === "active");
          if (active !== undefined) {
            active.status = "paused";
          }
        }
        const resumed = /^resume session (\d+)$/.exec(text)?.[1];
        const paused = sessions.find(({ id }) => String(id) === resumed);
        if (paused !== undefined) {
          paused.status = "active";
          sessionId = paused.id;
        }
        const message = (id: number, kind: "owner" | "grilling") => ({
          id,
          floorId: "web-shop",
          kind,
          text: kind === "owner" ? text : "On it.",
          command: null,
          replyTo: kind === "owner" ? null : 1,
          agentId: kind === "owner" ? null : "ada",
          model: null,
          skill: null,
          grilling: sessionId === undefined ? null : { sessionId, round: null },
          compaction: null,
          tools: [],
          attachments: [],
          createdAt: "2026-10-09T12:00:01.000Z",
        });
        return Promise.resolve(
          Response.json(
            {
              message: message(1, "owner"),
              reply: paused === undefined ? null : message(2, "grilling"),
            },
            { status: 201 },
          ),
        );
      }
      return stubbed(url, init);
    });
    return { posts, stop };
  };

  const meetingRoom = () =>
    screen.findByRole("button", { name: /^Meeting Room/ });
  const meetingPanel = () =>
    screen.findByRole("region", { name: "Meeting Room" });

  it("has a Meeting Room button beside the Manager chat's on a Floor, never in the lobby", async () => {
    planningServer([]);
    renderView();
    await sceneWithObjects(lobbyObjects);
    expect(screen.queryByRole("button", { name: /^Meeting Room/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Planning/ })).toBeNull();
    cleanup();

    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    const room = await meetingRoom();
    expect(room.textContent).toBe("Meeting Room");
    const chat = screen.getByRole("button", { name: "Chat with the Manager" });
    // Side by side, as prominent as each other.
    // (Meeting Room and its fast-forward button share a row of their own.)
    expect(room.parentElement?.parentElement).toBe(chat.parentElement);
    expect(room.className).toBe(chat.className);
  });

  it("Meeting Room calls the whole Floor to the table and opens the day's work, sending nothing; Return to desks ends it", async () => {
    const user = userEvent.setup();
    const { posts } = planningServer([]);
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    await user.click(await meetingRoom());
    expect(useMeetingRoomCall.getState().floorId).toBe("web-shop");
    const room = await meetingPanel();
    for (const card of [
      "Write a PRD",
      "File GitHub issues",
      "Complete issues",
      "Status update",
      "Stop everything",
      "Something else",
    ]) {
      expect(
        within(room).getByRole("heading", { name: card }),
        card,
      ).toBeTruthy();
    }
    expect(room.textContent).toContain("docs/product-requirements-document");
    expect(room.textContent).toContain("docs/architectural-decision-record");
    expect(posts).toEqual([]);
    // Closed, the Floor stays at the table.
    await user.click(
      within(room).getByRole("button", { name: "Close the Meeting Room" }),
    );
    expect(screen.queryByRole("region", { name: "Meeting Room" })).toBeNull();
    expect(useMeetingRoomCall.getState().floorId).toBe("web-shop");
    await user.click(
      await screen.findByRole("button", { name: "Return to desks" }),
    );
    expect(useMeetingRoomCall.getState().floorId).toBeUndefined();
    expect(posts).toEqual([]);
  });

  it("Write a PRD starts a Grilling Session with grill-with-docs or wayfinder, and opens its chat once it runs", async () => {
    const user = userEvent.setup();
    const { posts } = planningServer([{ id: 2, status: "ended" }]);
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    await user.click(await meetingRoom());
    const room = await meetingPanel();
    await user.click(within(room).getByRole("radio", { name: /large effort/ }));
    await user.type(within(room).getByLabelText("What is it?"), "CSV exports");
    const start = within(room).getByRole("button", { name: "Start grilling" });
    await waitFor(() => {
      expect((start as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(start);
    expect(posts).toEqual([{ text: "/wayfinder CSV exports", csrf: "csrf" }]);
    await sceneWithObjects(`${floorObjects} grilling-session:web-shop`);
    await waitFor(() => {
      expect(panel().kind).toBe("grilling-session");
    });
    expect(headingTo()).toBe("inspect:grilling-session:web-shop");
  });

  it("Complete issues sends the Batch, in one pull request unless the Owner says otherwise, and opens the Manager's chat", async () => {
    const user = userEvent.setup();
    const { posts } = planningServer([]);
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    await user.click(await meetingRoom());
    const room = await meetingPanel();
    await user.type(within(room).getByLabelText("Issues"), "1 to 10");
    const start = within(room).getByRole("button", { name: "Start work" });
    await waitFor(() => {
      expect((start as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(start);
    await waitFor(() => {
      expect(posts).toEqual([
        { text: "complete issues 1 to 10 in one PR", csrf: "csrf" },
      ]);
    });
    await waitFor(() => {
      expect(panel()).toMatchObject({ kind: "agent", name: "ada" });
    });
  });

  it("Stop everything stops the whole Floor, and Continue working lets the Agents carry on", async () => {
    const user = userEvent.setup();
    const { stop } = planningServer([]);
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    await user.click(await meetingRoom());
    const room = await meetingPanel();
    await user.click(
      await within(room).findByRole("button", { name: "Stop everything" }),
    );
    const carryOn = await within(room).findByRole("button", {
      name: "Continue working",
    });
    expect(
      within(room).getByText(
        "Everything is stopped: no Agent works until you continue.",
      ),
    ).toBeTruthy();
    await user.click(carryOn);
    await within(room).findByRole("button", { name: "Stop everything" });
    expect(stop.posts).toEqual([
      { url: "/api/floors/web-shop/stop", csrf: "csrf" },
      { url: "/api/floors/web-shop/continue", csrf: "csrf" },
    ]);
  });

  it("File GitHub issues breaks a PRD on the default branch into issues with to-tickets", async () => {
    const user = userEvent.setup();
    const { posts } = planningServer([]);
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    await user.click(await meetingRoom());
    const room = await meetingPanel();
    // Only the file name shows, cut short with an ellipsis when narrow; the
    // whole path is in its tooltip.
    const exports = await within(room).findByRole("checkbox", {
      name: "exports.md",
    });
    expect(exports.closest("label")?.title).toBe(
      "docs/product-requirements-document/exports.md",
    );
    await user.click(exports);
    const go = within(room).getByRole("button", { name: "Break into issues" });
    await waitFor(() => {
      expect((go as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(go);
    expect(posts).toEqual([
      {
        text: "/to-tickets docs/product-requirements-document/exports.md",
        csrf: "csrf",
      },
    ]);
  });

  it("while a session runs, Meeting Room says so and carries it on, sending nothing", async () => {
    const user = userEvent.setup();
    const { posts } = planningServer([{ id: 4, status: "active" }]);
    atWebShop();
    renderView();
    await sceneWithObjects(`${floorObjects} grilling-session:web-shop`);
    await user.click(
      await screen.findByRole("button", { name: "Meeting Room (in session)" }),
    );
    await user.click(
      within(await meetingPanel()).getByRole("button", {
        name: "Carry on with the running session",
      }),
    );
    expect(panel().kind).toBe("grilling-session");
    expect(posts).toEqual([]);
  });

  it("shows Return to desks only on a Floor while someone is away on an idle activity, and calls them back", async () => {
    const user = userEvent.setup();
    const { posts } = planningServer([]);
    useDeskReturnStore.getState().setWandering(true);
    renderView();
    await sceneWithObjects(lobbyObjects);
    expect(
      screen.queryByRole("button", { name: "Return to desks" }),
    ).toBeNull();
    cleanup();

    useDeskReturnStore.getState().setWandering(false);
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    await screen.findByRole("button", { name: "Meeting Room" });
    expect(
      screen.queryByRole("button", { name: "Return to desks" }),
    ).toBeNull();

    act(() => {
      useDeskReturnStore.getState().setWandering(true);
    });
    const back = await screen.findByRole("button", { name: "Return to desks" });
    // Beside Meeting Room and the Manager chat's button.
    expect(back.parentElement).toBe(
      screen.getByRole("button", { name: "Chat with the Manager" })
        .parentElement,
    );
    await user.click(back);
    expect(useDeskReturnStore.getState().requests).toBe(1);
    // No session to pause.
    expect(posts).toEqual([]);
    act(() => {
      useDeskReturnStore.getState().setWandering(false);
    });
    expect(
      screen.queryByRole("button", { name: "Return to desks" }),
    ).toBeNull();
  });

  it("Return to desks pauses a running Grilling Session as its Pause button does, so the Meeting Room resumes it later", async () => {
    const user = userEvent.setup();
    const { posts } = planningServer([{ id: 4, status: "active" }]);
    atWebShop();
    renderView();
    await sceneWithObjects(`${floorObjects} grilling-session:web-shop`);
    const back = await screen.findByRole("button", { name: "Return to desks" });
    await waitFor(() => {
      expect((back as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(back);
    expect(posts).toEqual([{ text: "pause the session", csrf: "csrf" }]);
    expect(useDeskReturnStore.getState().requests).toBe(1);
    // Paused: the Floor walks back, and the Meeting Room resumes it.
    await sceneWithObjects(floorObjects);
    expect(screen.getByTestId("scene").dataset["grilling"]).toBe("none");
    expect(
      screen.queryByRole("button", { name: "Return to desks" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Meeting Room" }));
    const resume = within(await meetingPanel()).getByRole("button", {
      name: "Resume session 4",
    });
    await waitFor(() => {
      expect((resume as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(resume);
    expect(posts.at(-1)).toEqual({ text: "resume session 4", csrf: "csrf" });
  });

  it("while a Grilling Session runs, gives the scene its round and fact-finding, and opens the session chat from its table, the Manager or the whiteboard (FR-83)", async () => {
    const question = (number: number, status: "open" | "answered") => ({
      number,
      round: 1,
      text: `Which records does export ${String(number)} hold?`,
      recommended: "Orders only.",
      dependsOn: [],
      status,
      answer: status === "answered" ? "Orders only." : null,
      acceptedRecommended: status === "answered",
      answeredAt: null,
    });
    const session = {
      id: 1,
      floorId: "web-shop",
      topic: "CSV export",
      status: "active" as "active" | "ended",
      round: 1,
      awaitingConfirmation: false,
      openQuestions: 1,
      decisionCount: 0,
      startedAt: "2026-10-09T12:00:00.000Z",
      updatedAt: "2026-10-09T12:00:00.000Z",
      pausedAt: null,
      endedAt: null as string | null,
      questions: [question(1, "answered"), question(2, "open")],
      decisions: [],
      terms: [],
      facts: [],
      outline: [],
      adrs: [],
      processes: [],
      documents: null,
      issues: null,
    };
    const roundMessage = {
      id: 2,
      floorId: "web-shop",
      kind: "reply",
      text: "Round 1: 2 questions.",
      command: null,
      replyTo: 1,
      agentId: "ada",
      model: "claude-opus-5-5",
      skill: null,
      grilling: { sessionId: 1, round: 1 },
      compaction: null,
      tools: [],
      attachments: [],
      createdAt: "2026-10-09T12:00:01.000Z",
    };
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url === "/api/floors/web-shop/grilling-sessions") {
        fetched.push(url);
        return Promise.resolve(
          Response.json({
            sessions: [{ ...session, questions: undefined }],
          }),
        );
      }
      if (url === "/api/floors/web-shop/grilling-sessions/1") {
        return Promise.resolve(Response.json({ session, messages: [] }));
      }
      if (url === "/api/floors/web-shop/manager-chat") {
        return Promise.resolve(
          Response.json({
            manager: {
              id: "ada",
              name: "ada",
              aiProvider: "Claude",
              model: "claude-opus-5-5",
            },
            messages: [roundMessage],
            pending: [],
          }),
        );
      }
      return stubbed(url, init);
    });
    atWebShop();
    renderView();
    await sceneWithObjects(`${floorObjects} grilling-session:web-shop`);
    const scene = screen.getByTestId("scene");
    await waitFor(() => {
      expect(scene.dataset["grilling"]).toBe(
        "1:round 1 answered,open 0 decisions",
      );
    });
    expect(scene.dataset["factFinding"]).toBe("");

    // The session chat, from the table (and so from the Manager and the
    // whiteboard, which open it while the session runs).
    const objects = floorInspectables(
      "web-shop",
      server.agents["web-shop"] ?? [],
      { grilling: true },
    );
    const table = objects.find(({ kind }) => kind === "grilling-session");
    expect(table).toBeDefined();
    act(() => {
      if (table !== undefined) {
        openInspectable(table);
      }
    });
    const shown = panel();
    expect(shown.kind).toBe("grilling-session");
    expect(shown.name).toBe("The Grilling Session");
    expect(shown.text).toContain(
      "ada is at the meeting room's table for the session",
    );
    expect(shown.links).toEqual([
      ["Open the Manager chat", "/floors/web-shop/manager"],
    ]);
    expect(headingTo()).toBe("inspect:grilling-session:web-shop");
    // Its round's question cards, to answer there.
    expect(
      await screen.findByLabelText("Your answer to question 2"),
    ).toBeTruthy();
    // The Manager's status line, compact, over the session's chat.
    expect(await screen.findByLabelText("The Manager's usage")).toBeTruthy();
    expect(
      within(screen.getByLabelText("The Manager's usage")).getByText(
        "Context Usage",
      ),
    ).toBeTruthy();
    // The whiteboard and the Manager's card are a button away.
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Open the whiteboard" }));
    expect(panel().kind).toBe("whiteboard");

    // An Agent sent to find a fact: the team's stream brings it.
    const stream = streams.find(({ url }) => url.includes("agent.created"));
    expect(stream?.url).toContain("grilling.fact_finding_started");
    act(() => {
      stream?.send(
        storedEvent(20, {
          type: "grilling.fact_finding_started",
          version: 1,
          floorId: "web-shop",
          agentId: "bo",
          sessionId: 1,
          sandboxId: "sbx-1",
        }),
      );
    });
    await waitFor(() => {
      expect(scene.dataset["factFinding"]).toBe("20:bo");
    });

    // The session ends: the Floor's sessions are read again, and the table
    // is no longer an object.
    session.status = "ended";
    session.endedAt = "2026-10-09T12:30:00.000Z";
    const before = fetched.filter(
      (url) => url === "/api/floors/web-shop/grilling-sessions",
    ).length;
    act(() => {
      stream?.send(
        storedEvent(21, {
          type: "grilling.session_changed",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          sessionId: 1,
          change: "ended",
          status: "ended",
          round: 1,
          openQuestions: 0,
          decisions: 2,
        }),
      );
    });
    await sceneWithObjects(floorObjects);
    expect(scene.dataset["grilling"]).toBe("none");
    expect(
      fetched.filter((url) => url === "/api/floors/web-shop/grilling-sessions")
        .length,
    ).toBeGreaterThan(before);
  });

  it("opens the lobby's Notice Board panel, linking to the 2D Notice Board", async () => {
    renderView();
    await sceneWithObjects(lobbyObjects);
    act(() => {
      openInspectable(lobbyInspectables()[0] ?? fail());
    });
    expect(panel()).toMatchObject({
      kind: "notice-board",
      name: "The Notice Board",
      links: [["Open the Notice Board", "/notices"]],
    });
  });

  it("opens the Communications Agent's card at reception, linking to the Connections admin", async () => {
    server.connections = [
      connection("c-1", "Team chat", { failing: true }),
      connection("c-2", "Phone"),
    ];
    renderView();
    await sceneWithObjects(lobbyObjects);
    act(() => {
      openInspectable(lobbyInspectables("Grace")[1] ?? fail());
    });
    expect(headingTo()).toBe("inspect:agent:communications");
    await waitFor(() => {
      expect(panel().text).toContain("Failing: Team chat");
    });
    expect(panel()).toMatchObject({
      kind: "agent",
      name: "Grace",
      links: [["Open the Connections admin", "/general-settings/connections"]],
    });
    expect(panel().text).toContain("2 Connections");
    expect(panel().text).toContain("claude-opus-5-5");
  });

  it("shows the Floor's wall board in its panel, whose Agents' names fly to them", async () => {
    const user = userEvent.setup();
    server.notices = [
      notice("n-1", {
        kind: "action",
        title: "Agent blocked",
        floorId: "web-shop",
        agentId: "bo",
      }),
      notice("n-2", { title: "Elsewhere", floorId: "blog" }),
    ];
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    act(() => {
      openInspectable(webShop()[1] ?? fail());
    });
    const board = within(screen.getByRole("dialog"));
    // This Floor's Notices only, and its health from them.
    await board.findByText("Needs you");
    expect(board.getByText("Agent blocked")).toBeTruthy();
    expect(board.queryByText("Elsewhere")).toBeNull();
    expect(board.getByRole("heading", { name: "Notices (1)" })).toBeTruthy();
    expect(fetched).toEqual(
      expect.arrayContaining([
        "/api/notices?floorId=web-shop",
        "/api/floors/web-shop/wall-board",
        "/api/floors/web-shop/token-usage",
      ]),
    );

    // The Notice's Agent's name flies to the Agent and opens its card, and
    // closing that flies back to where the camera was before the wall board.
    await user.click(board.getByRole("button", { name: "bo" }));
    expect(panel()).toMatchObject({ kind: "agent", name: "bo" });
    expect(headingTo()).toBe("inspect:agent:bo");
    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(headingTo()).toBe(defaultView);
  });

  it("opens the same panel from the keyboard list, and Escape closes it and flies back", async () => {
    const user = userEvent.setup();
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);

    // Selected in the scene first, to compare with, once it has read the Floor.
    act(() => {
      openInspectable(webShop()[1] ?? fail());
    });
    await within(screen.getByRole("dialog")).findByText("Running smoothly");
    const fromTheScene = panel();
    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Now only from the keyboard: into the list, down to the wall board.
    const list = await openList(user);
    await user.tab();
    expect(document.activeElement?.textContent).toBe("The whiteboard");
    await user.keyboard("{ArrowDown}");
    const wallBoard = list.getByRole("button", { name: "The wall board" });
    expect(document.activeElement).toBe(wallBoard);
    // Focused in the list, it is highlighted in the scene.
    expect(useSelectionStore.getState().hovered).toEqual({
      kind: "wall-board",
      id: "web-shop",
    });
    await user.keyboard("{Enter}");

    expect(panel()).toEqual(fromTheScene);
    expect(headingTo()).toBe("inspect:wall-board:web-shop");
    expect(wallBoard.getAttribute("aria-current")).toBe("true");
    // Focus moves into the panel.
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(headingTo()).toBe(defaultView);
    // And back to where it was.
    expect(document.activeElement).toBe(wallBoard);

    // The list wraps round, and Home and End go to its ends.
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("bo");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("The whiteboard");
    await user.keyboard("{ArrowUp}{Home}");
    expect(document.activeElement?.textContent).toBe("The whiteboard");
  });

  it("closes with its close button, flying back to the view the camera was at", async () => {
    const user = userEvent.setup();
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    await user.click(screen.getByRole("button", { name: "Plan" }));
    act(() => {
      openInspectable(webShop()[4] ?? fail());
    });
    expect(headingTo()).toBe("inspect:monitor:ada");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Close panel",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSelectionStore.getState().selected).toBeUndefined();
    expect(headingTo()).toBe("plan");
  });

  it("moves its panels within the view, and Escape leaves full screen before closing", async () => {
    // The view as a wide screen lays it out (jsdom lays nothing out).
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-panel-area") ? 1000 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-panel-area") ? 700 : 0;
      },
    );
    Element.prototype.setPointerCapture = vi.fn();
    const user = userEvent.setup();
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    act(() => {
      openInspectable(webShop()[4] ?? fail());
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.closest("[data-panel-area]")).not.toBeNull();
    expect(dialog.dataset["layout"]).toBe("docked");

    within(dialog).getByRole("button", { name: "Move panel" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(dialog.dataset["layout"]).toBe("placed");
    expect(dialog.style.position).toBe("absolute");

    await user.click(
      within(dialog).getByRole("button", { name: "Full screen" }),
    );
    expect(dialog.style.position).toBe("fixed");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog").dataset["layout"]).toBe("placed");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    localStorage.removeItem(panelLayoutKey);
  });

  it("closes when the lift rides elsewhere, leaving the camera to the lift", async () => {
    const user = userEvent.setup();
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    act(() => {
      openInspectable(webShop()[0] ?? fail());
    });
    await user.click(
      within(screen.getByRole("navigation", { name: "Floors" })).getByRole(
        "button",
        { name: "Blog" },
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(headingTo()).toBe(liftViewName);
  });

  it("shows a working Agent's live activity in its monitor's panel, live", async () => {
    server.events = [
      statusEvent(1, "bo", "working"),
      said(2, "bo", "Running the tests."),
      said(3, "ada", "Not this Agent's"),
    ];
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    act(() => {
      openInspectable(webShop()[5] ?? fail());
    });
    expect(panel().name).toBe("bo's monitor");
    const log = within(screen.getByRole("dialog")).getByRole("log", {
      name: "Live activity",
    });
    await waitFor(() => {
      expect(log.textContent).toContain("Running the tests.");
    });
    expect(log.textContent).toContain("Now working on #4");
    expect(log.textContent).not.toContain("Not this Agent's");

    // New activity streams in while the panel is open.
    const live = streams.find(({ url }) => url.includes("agentId=bo"));
    expect(live?.url).toContain("lastEventId=2");
    act(() => {
      live?.send(said(4, "bo", "12 passed"));
    });
    await waitFor(() => {
      expect(log.textContent).toContain("12 passed");
    });
    // It still links to the live view's own page.
    expect(panel().links).toEqual([
      ["Open the live view", "/floors/web-shop/agents/bo"],
    ]);

    // Closed, it stops following the Agent.
    await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(live?.readyState).toBe(2);
  });

  it("closes an Agent's monitor when the Agent leaves the Floor", async () => {
    atWebShop();
    renderView();
    await sceneWithObjects(floorObjects);
    act(() => {
      openInspectable(webShop()[5] ?? fail());
    });
    expect(panel().name).toBe("bo's monitor");

    server.agents["web-shop"] = [agent("web-shop", "ada", "manager")];
    const stream = streams.find(({ url }) => url.includes("agent.removed"));
    act(() => {
      stream?.send({
        id: 3,
        occurredAt: "2026-10-08T12:10:00.000Z",
        event: {
          type: "agent.removed",
          version: 1,
          floorId: "web-shop",
          agentId: "bo",
        },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(headingTo()).toBe(defaultView);
  });

  it("opens an object from the Office's address, riding the lift to its Floor first", async () => {
    const onInspect = vi.fn();
    renderView(undefined, {
      inspect: {
        kind: "monitor",
        id: "bo",
        location: { kind: "floor", floorId: "web-shop" },
      },
      onInspect,
    });
    // The lift is called once the Floors are known.
    await waitFor(() => {
      expect(liftGoingTo()).toEqual({ kind: "floor", floorId: "web-shop" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      useLiftStore.getState().advance(10, false);
    });
    // Once its Agents are in, the monitor opens and the camera flies in.
    await waitFor(() => {
      expect(panel().name).toBe("bo's monitor");
    });
    expect(headingTo()).toBe("inspect:monitor:bo");
    // The address already says so; it is not told again.
    expect(onInspect).not.toHaveBeenCalled();

    // What opens and closes from now on, it is told.
    act(() => {
      openInspectable(webShop()[0] ?? fail());
    });
    expect(onInspect).toHaveBeenLastCalledWith({
      kind: "whiteboard",
      id: "web-shop",
      location: { kind: "floor", floorId: "web-shop" },
    });
    await userEvent.setup().keyboard("{Escape}");
    expect(onInspect).toHaveBeenLastCalledWith(undefined);
    expect(headingTo()).toBe(defaultView);
  });

  it("opens nothing for an address that names no object, or a Floor that is not one", async () => {
    const onInspect = vi.fn();
    const view = renderView(undefined, {
      inspect: {
        kind: "monitor",
        id: "nobody",
        location: { kind: "floor", floorId: "web-shop" },
      },
      onInspect,
    });
    await waitFor(() => {
      expect(liftGoingTo()).toEqual({ kind: "floor", floorId: "web-shop" });
    });
    act(() => {
      useLiftStore.getState().advance(10, false);
    });
    await sceneWithObjects(floorObjects);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Once given up on, what opens is told again.
    act(() => {
      openInspectable(webShop()[2] ?? fail());
    });
    expect(onInspect).toHaveBeenCalledTimes(1);
    view.unmount();
    resetLift();
    resetSelection();

    renderView(undefined, {
      inspect: {
        kind: "whiteboard",
        id: "gone",
        location: { kind: "floor", floorId: "gone" },
      },
    });
    await sceneWithObjects(lobbyObjects);
    // No such Floor: the lift stays in the lobby.
    expect(liftGoingTo()).toEqual({ kind: "lobby" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/** Where the lift is going, or is if it is not going anywhere. */
const liftGoingTo = () =>
  liftDestination(useLiftStore.getState().lift).location;

function fail(): never {
  throw new Error("The place is missing an object.");
}
