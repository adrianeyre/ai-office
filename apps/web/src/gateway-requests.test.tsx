import type {
  GatewayLogLine,
  GatewayRequestDetail,
  GatewayRequestSummary,
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

import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Request history in the web app (PRD FR-44): the list, its filters in
// the address, new requests streaming in, one request's detail, the live
// Gateway log, and the body storage setting.

const summary = (
  id: number,
  fields: Partial<GatewayRequestSummary> = {},
): GatewayRequestSummary => ({
  id,
  startedAt: "2026-10-09T12:00:00.000Z",
  endpoint: "messages",
  model: "claude-opus-5-5",
  streamed: true,
  status: 200,
  latencyMs: 820,
  timeToFirstByteMs: 310,
  inputTokens: 1200,
  outputTokens: 40,
  cacheReadInputTokens: 2048,
  cacheCreationInputTokens: 0,
  estimatedCostUsd: 0.0012,
  account: "Work",
  aiAccountId: "account-1",
  agentId: null,
  floorId: null,
  ownerTool: "Codex",
  issue: null,
  pullRequest: null,
  upstreamRequestId: "req_1",
  keepAlive: false,
  ...fields,
});

interface FakeStream extends EventSourceLike {
  readonly url: string;
  readyState: number;
  send(data: unknown): void;
}

let streams: FakeStream[] = [];
let storeBodies = true;

function stubServer(
  options: {
    requests?: GatewayRequestSummary[];
    detail?: GatewayRequestDetail;
  } = {},
) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      asked.push(url);
      const method = init?.method ?? "GET";
      if (
        url.startsWith("/api/gateway/requests?") ||
        url === "/api/gateway/requests"
      ) {
        return Promise.resolve(
          Response.json({ requests: options.requests ?? [], nextBefore: null }),
        );
      }
      if (url.startsWith("/api/gateway/requests/")) {
        return Promise.resolve(
          options.detail === undefined
            ? Response.json(
                { error: "gateway_request_not_found" },
                { status: 404 },
              )
            : Response.json(options.detail),
        );
      }
      if (url === "/api/office/request-bodies") {
        if (method === "PUT") {
          storeBodies = (JSON.parse(init?.body as string) as { store: boolean })
            .store;
        }
        return Promise.resolve(Response.json({ store: storeBodies }));
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      if (url === "/health") {
        return Promise.resolve(Response.json({ status: "ok", database: "up" }));
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { asked };
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

const rows = async () => {
  const table = await screen.findByRole("table", { name: "Gateway requests" });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("aria-label"));
};

const streamAt = (prefix: string) =>
  waitFor(() => {
    const found = streams.find(({ url }) => url.startsWith(prefix));
    if (found === undefined) {
      throw new Error(`No stream at ${prefix} yet.`);
    }
    return found;
  });

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
  storeBodies = true;
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

describe("Gateway requests", () => {
  it("lists requests newest first, and new ones stream in at the top", async () => {
    stubServer({
      requests: [
        summary(2, {
          status: 429,
          estimatedCostUsd: null,
          issue: 4,
          pullRequest: 7,
        }),
        summary(1),
      ],
    });
    renderAt("/gateway");
    expect(await rows()).toEqual(["Request 2", "Request 1"]);
    // What a request was for, as its caller said (FR-42).
    expect(
      screen.getByRole("row", { name: "Request 2" }).querySelectorAll("td")[3]
        ?.textContent,
    ).toBe("Codex for #4, PR #7");
    const row = screen.getByRole("row", { name: "Request 1" });
    expect(
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    ).toEqual([
      new Date("2026-10-09T12:00:00.000Z").toLocaleString(),
      "Messages(streamed)",
      "claude-opus-5-5",
      "Codex",
      "Work",
      "200",
      "1,200 / 40",
      "$0.0012",
      "820 ms",
    ]);

    // The stream resumes right after the newest request listed.
    const live = await streamAt("/api/gateway/requests/stream");
    expect(live.url).toBe("/api/gateway/requests/stream?lastEventId=2");
    act(() => {
      live.onopen?.(new Event("open"));
      live.send(summary(3, { model: "claude-haiku-5-5" }));
      live.send(summary(2));
    });
    await waitFor(async () => {
      expect(await rows()).toEqual(["Request 3", "Request 2", "Request 1"]);
    });
    expect(screen.getByText("Live.").getAttribute("role")).toBe("status");
  });

  it("marks the prompt-cache keep-alives the Gateway sent for an Agent", async () => {
    stubServer({
      requests: [
        summary(2, {
          streamed: false,
          agentId: "ada",
          floorId: "web-shop",
          ownerTool: null,
          keepAlive: true,
        }),
        summary(1),
      ],
    });
    renderAt("/gateway");
    expect(await rows()).toEqual(["Request 2", "Request 1"]);
    const cell = (id: number) =>
      screen
        .getByRole("row", { name: `Request ${String(id)}` })
        .querySelectorAll("td")[1]?.textContent;
    expect(cell(2)).toBe("Messages(keep-alive)");
    expect(cell(1)).toBe("Messages(streamed)");
  });

  it("keeps its filters in the address, and asks for them", async () => {
    const { asked } = stubServer({ requests: [] });
    const router = renderAt("/gateway?status=5xx");
    await screen.findByText("No requests yet.");
    expect(asked).toContain("/api/gateway/requests?status=5xx");
    await userEvent.selectOptions(
      screen.getByLabelText("Endpoint"),
      "responses",
    );
    await userEvent.type(screen.getByLabelText("Search"), "codex{Enter}");
    await waitFor(() => {
      expect(router.state.location.search).toEqual({
        status: "5xx",
        endpoint: "responses",
        q: "codex",
      });
    });
    await waitFor(() => {
      expect(asked).toContain(
        "/api/gateway/requests?q=codex&status=5xx&endpoint=responses",
      );
    });
    const live = await streamAt(
      "/api/gateway/requests/stream?q=codex&status=5xx&endpoint=responses",
    );
    expect(live.url).toContain("lastEventId=0");
  });

  it("shows the Gateway's log as it is written", async () => {
    stubServer();
    renderAt("/gateway");
    const logs = await streamAt("/api/gateway/logs/stream");
    const line = (id: number, message: string): GatewayLogLine => ({
      id,
      time: "2026-10-09T12:00:00.000Z",
      level: id === 2 ? "warn" : "info",
      message,
      fields: { component: "gateway" },
    });
    act(() => {
      logs.send(line(1, "A Gateway request finished."));
      logs.send(line(2, "A request without a Gateway Key in use was refused."));
      logs.send(line(1, "A Gateway request finished."));
    });
    const log = await screen.findByRole("list", { name: "Gateway log" });
    await waitFor(() => {
      expect(
        within(log)
          .getAllByRole("listitem")
          .map((item) => item.textContent.slice(-60)),
      ).toEqual([
        expect.stringContaining("infoA Gateway request finished."),
        expect.stringContaining(
          "warnA request without a Gateway Key in use was refused.",
        ),
      ]);
    });
  });
});

describe("one Gateway request", () => {
  const detail = (
    bodies: GatewayRequestDetail["bodies"],
  ): GatewayRequestDetail => ({
    ...summary(7),
    requestHeaders: {
      "x-api-key": "[REDACTED]",
      "anthropic-version": "2023-06-01",
    },
    responseHeaders: { "content-type": "text/event-stream" },
    bodies,
  });

  it("shows its timings, tokens, cost, account, caller, headers and bodies", async () => {
    stubServer({
      detail: detail({
        request: '{"model":"claude-opus-5-5"}',
        response: "event: message_stop",
        truncated: false,
      }),
    });
    renderAt("/gateway/requests/7");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Request 7" }),
    ).toBeDefined();
    for (const text of [
      "820 ms",
      "310 ms",
      "1,200",
      "2,048 / 0",
      "$0.0012",
      "Work",
      "Codex",
      "req_1",
    ]) {
      expect(screen.getAllByText(text).length, text).toBeGreaterThan(0);
    }
    const headers = screen.getByRole("table", { name: "Request headers" });
    expect(within(headers).getByText("[REDACTED]")).toBeDefined();
    expect(
      within(screen.getByRole("region", { name: "Request body" })).getByText(
        '{"model":"claude-opus-5-5"}',
      ),
    ).toBeDefined();
  });

  it("says when it was a prompt-cache keep-alive", async () => {
    stubServer({ detail: { ...detail(null), keepAlive: true } });
    renderAt("/gateway/requests/7");
    expect(
      await screen.findByText(
        /^A prompt-cache keep-alive: the AI Gateway sent it/,
      ),
    ).toBeDefined();
  });

  it("says when its bodies were not kept", async () => {
    stubServer({ detail: detail(null) });
    renderAt("/gateway/requests/7");
    expect(
      await screen.findByText(/Bodies were not kept for this request/),
    ).toBeDefined();
  });

  it("says when there is no such request", async () => {
    stubServer();
    renderAt("/gateway/requests/8");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "There is no such Gateway request.",
    );
  });
});

describe("the body storage setting in AI Settings", () => {
  it("turns body storage off and on", async () => {
    stubServer();
    renderAt("/ai-settings");
    const box = await screen.findByRole("checkbox", {
      name: "Keep request and response bodies (encrypted)",
    });
    await waitFor(() => {
      expect((box as HTMLInputElement).checked).toBe(true);
    });
    await waitFor(() => {
      expect((box as HTMLInputElement).disabled).toBe(false);
    });
    await userEvent.click(box);
    await waitFor(() => {
      expect((box as HTMLInputElement).checked).toBe(false);
    });
    expect(storeBodies).toBe(false);
  });
});
