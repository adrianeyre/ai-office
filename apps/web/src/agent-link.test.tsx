import {
  builtInRole,
  noTokens,
  randomAvatar,
  type Agent,
  type Notice,
  type Role,
} from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { destination } from "./scene/camera-rig.ts";
import { resetCamera, useCameraStore } from "./scene/camera-store.ts";
import { floorInspectables } from "./scene/inspectable.ts";
import { liftDestination } from "./scene/lift.ts";
import { resetLift, useLiftStore } from "./scene/lift-store.ts";
import { resetSelection, useSelectionStore } from "./scene/selection-store.ts";
import { webgl } from "./scene/webgl.ts";

// An Agent's name, anywhere in the UI, flies the camera to that Agent
// (PRD FR-63; §5 scenario 2: "They click the Agent's name in a Notice and
// the camera flies to its desk"). From the 2D Notice Board, the name goes
// to the Office, whose lift rides to the Agent's Floor; there the camera
// flies to the Agent and its card opens. jsdom has no WebGL, so the canvas
// is a stand-in; the Office around it, its stores and the router are real.
vi.mock("./scene/office-scene.tsx", () => ({
  OfficeScene: () => <div data-testid="scene" />,
}));

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

const team = [agent("ada", "Ada", "manager"), agent("bo", "Bo", "coder")];

const blocked: Notice = {
  id: "notice-1",
  kind: "action",
  title: "Agent blocked",
  floorId: "web-shop",
  agentId: "bo",
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
};

const webShop = {
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

function reply(url: string): Response {
  const path = url.split("?")[0];
  switch (path) {
    case "/api/session":
      return Response.json({
        csrfToken: "csrf-token",
        expiresAt: "2026-10-15T12:00:00.000Z",
      });
    case "/api/notices":
      return Response.json({ notices: [blocked] });
    case "/api/floors":
      return Response.json({ floors: [webShop] });
    case "/api/floors/web-shop":
      return Response.json(webShop);
    case "/api/floors/web-shop/agents":
      return Response.json({ agents: team });
    case "/api/floors/web-shop/wall-board":
      return Response.json({
        floorId: "web-shop",
        roundCap: 3,
        qaRoundCap: 3,
        issues: [],
        queues: [],
        agents: [],
      });
    case "/api/floors/web-shop/token-usage":
      return Response.json({
        floorId: "web-shop",
        caps: { daily: null, monthly: null },
        agentDefaults: {
          daily: { level: "office", cap: 1_000 },
          monthly: { level: "office", cap: 10_000 },
        },
        usage: { daily: noTokens, monthly: noTokens },
        agents: [],
        issues: [],
      });
    case "/api/events":
      return Response.json({ events: [], nextBefore: null });
    default:
      return Response.json({ status: "ok", database: "up" });
  }
}

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

beforeEach(() => {
  resetCamera();
  resetLift();
  resetSelection();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(webgl, "available").mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => Promise.resolve(reply(url))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an Agent's name", () => {
  it("links to the Agent in the Office", async () => {
    renderAt("/notices");
    const name = await screen.findByRole("link", { name: "Agent: Bo" });
    expect(name.getAttribute("href")).toBe(
      "/?floor=web-shop&inspect=agent%3Abo",
    );
    expect(name.getAttribute("title")).toBe("Show Bo in the Office");
  });

  it("sets the camera's target to the Agent, from a Notice, and opens its card", async () => {
    const router = renderAt("/notices");
    await userEvent
      .setup()
      .click(await screen.findByRole("link", { name: "Agent: Bo" }));

    // The Office: its lift rides to the Agent's Floor first.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(router.state.location.search).toEqual({
      floor: "web-shop",
      inspect: "agent:bo",
    });
    await waitFor(() => {
      expect(liftDestination(useLiftStore.getState().lift).location).toEqual({
        kind: "floor",
        floorId: "web-shop",
      });
    });
    act(() => {
      useLiftStore.getState().advance(10, false);
    });

    // There, the camera flies to the Agent where it sits.
    await waitFor(() => {
      expect(destination(useCameraStore.getState().rig)).toBe(
        "inspect:agent:bo",
      );
    });
    const bo =
      floorInspectables("web-shop", team).find(
        ({ kind, id }) => kind === "agent" && id === "bo",
      ) ?? fail();
    expect(useCameraStore.getState().views["inspect:agent:bo"]).toEqual(
      bo.view,
    );
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "agent",
      id: "bo",
    });
    // And its card opens beside it.
    const card = await screen.findByRole("dialog");
    expect(card.dataset["kind"]).toBe("agent");
    expect(
      await screen.findByRole("button", { name: "Open Bo's monitor" }),
    ).toBeTruthy();
  });
});

function fail(): never {
  throw new Error("Not found.");
}
