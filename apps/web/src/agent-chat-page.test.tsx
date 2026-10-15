import {
  randomAvatar,
  type Agent,
  type AiAccount,
  type DirectChat,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { createAppRouter } from "./router.tsx";

// An Agent's direct chat on its own page, against a stubbed server: its
// status line, as the Manager chat's, for the Agent's own conversation:
// its Context Usage from its latest reply, its tokens against its Token
// Caps, and the plan usage of the subscription that served it, kept live
// by the Agent's requests on the AI Gateway's stream.

const bo: Agent = {
  id: "bo",
  floorId: "web-shop",
  name: "Bo",
  role: "coder",
  stage: "work",
  aiProvider: "ChatGPT",
  model: "gpt-5.5-codex",
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
};

const totals = (tokens: number) => ({
  requests: 1,
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  tokens,
  estimatedCostUsd: 0,
});

const codex = (fiveHour: number, weekly: number): AiAccount => ({
  id: "codex",
  name: "Codex Pro",
  aiProvider: "ChatGPT",
  accountType: "oauth",
  endpointUrl: null,
  region: null,
  projectId: null,
  priority: 1,
  paused: false,
  tokenHealth: "valid",
  tokenExpiresAt: "2099-10-20T00:00:00.000Z",
  reauthenticationNeeded: false,
  limitReason: null,
  limitedUntil: null,
  usage: {
    fiveHour: { utilization: fiveHour, resetsAt: "2099-10-09T15:00:00.000Z" },
    weekly: { utilization: weekly, resetsAt: "2099-10-14T09:00:00.000Z" },
  },
  fiveHourPauseThreshold: null,
  weeklyPauseThreshold: null,
  forcedModel: null,
  extraUsage: null,
  createdAt: "2026-10-09T11:00:00.000Z",
  updatedAt: "2026-10-09T11:00:00.000Z",
});

interface FakeStream extends Omit<EventSourceLike, "readyState"> {
  readyState: number;
  readonly url: string;
  send(data: unknown): void;
}

let streams: FakeStream[];

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

describe("an Agent's direct chat on its own page", () => {
  it("shows the Agent's Context Usage in its chat, its tokens against its Token Caps and the serving subscription, kept live", async () => {
    const state = { inputTokens: 100_000, today: 400, fiveHour: 20 };
    const chat = (): DirectChat => ({
      name: "Bo",
      aiProvider: "ChatGPT",
      model: "gpt-5.5-codex",
      messages: [],
      pending: [],
      models: [],
      usage: {
        model: "gpt-5.5-codex",
        inputTokens: state.inputTokens,
        contextWindow: 400_000,
        contextUsage: state.inputTokens / 400_000,
        aiAccountId: "codex",
        updatedAt: "2026-10-09T12:00:00.000Z",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const body = (() => {
          switch (url) {
            case "/api/floors/web-shop/agents":
              return { agents: [bo] };
            case "/api/floors/web-shop/agents/bo/chat":
              return chat();
            case "/api/floors/web-shop/token-usage":
              return {
                floorId: "web-shop",
                caps: { daily: null, monthly: null },
                agentDefaults: {
                  daily: { level: "office", cap: 1_000 },
                  monthly: { level: "office", cap: 10_000 },
                },
                usage: { daily: totals(0), monthly: totals(0) },
                agents: [
                  {
                    agentId: "bo",
                    usage: {
                      daily: totals(state.today),
                      monthly: totals(2_000),
                    },
                    caps: {
                      daily: { level: "office", cap: 1_000, used: state.today },
                      monthly: { level: "agent", cap: 10_000, used: 2_000 },
                    },
                  },
                ],
                issues: [],
              };
            case "/api/ai-accounts":
              return { accounts: [codex(state.fiveHour, 50)] };
            case "/api/session":
              return {
                csrfToken: "csrf",
                expiresAt: "2026-10-15T12:00:00.000Z",
              };
            default:
              return undefined;
          }
        })();
        return Promise.resolve(
          body === undefined
            ? Response.json({}, { status: 404 })
            : Response.json(body),
        );
      }),
    );
    render(
      <App
        router={createAppRouter(
          createMemoryHistory({
            initialEntries: ["/floors/web-shop/agents/bo/chat"],
          }),
        )}
        queryClient={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      />,
    );
    const line = await screen.findByLabelText("Bo's usage");
    const meter = (name: string | RegExp) =>
      within(line).findByRole("meter", { name });
    expect((await meter("Context Usage")).getAttribute("aria-valuenow")).toBe(
      "25",
    );
    await waitFor(() => {
      expect(line.textContent).toContain("Today 40%");
    });
    expect(line.textContent).toContain("This month 20%");
    expect(
      (await meter(/^5-hour window used/)).getAttribute("aria-valuenow"),
    ).toBe("20");
    expect(line.textContent).toContain("Served by Codex Pro");

    // One of Bo's requests is recorded: everything is read again.
    state.inputTokens = 200_000;
    state.today = 900;
    state.fiveHour = 60;
    const requests = streams.find(
      ({ url }) =>
        url === "/api/gateway/requests/stream?floorId=web-shop&agentId=bo",
    );
    expect(requests).toBeDefined();
    act(() => {
      requests?.send({ id: 12 });
    });
    await waitFor(async () => {
      expect((await meter("Context Usage")).getAttribute("aria-valuenow")).toBe(
        "50",
      );
    });
    await waitFor(() => {
      expect(line.textContent).toContain("Today 90%");
    });
    await waitFor(async () => {
      expect(
        (await meter(/^5-hour window used/)).getAttribute("aria-valuenow"),
      ).toBe("60");
    });
  });
});
