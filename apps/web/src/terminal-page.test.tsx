import type {
  AiAccount,
  DirectChat,
  DirectChatMessage,
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
import { withDirectFrame } from "./direct-chat.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { createAppRouter } from "./router.tsx";

// The Terminal, against a stubbed server: the conversation so far, the
// Model chosen from the AI Providers' defaults, and the AI's reply
// streaming in a piece at a time.

const message = (
  id: number,
  kind: DirectChatMessage["kind"],
  text: string,
): DirectChatMessage => ({
  id,
  kind,
  text,
  replyTo: kind === "owner" || kind === "clear" ? null : id - 1,
  model: "claude-opus-5-5",
  createdAt: new Date(Date.UTC(2026, 9, 10, 12, 0, id)).toISOString(),
});

const terminal = (messages: DirectChatMessage[]): DirectChat => ({
  name: "the AI",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  messages,
  pending: [],
  models: [
    { aiProvider: "Claude", model: "claude-opus-5-5" },
    { aiProvider: "ChatGPT", model: "gpt-5.5" },
  ],
});

interface FakeStream extends Omit<EventSourceLike, "readyState"> {
  readyState: number;
  readonly url: string;
  send(data: unknown): void;
}

let streams: FakeStream[];
let posts: unknown[];

function stubServer(chat: DirectChat) {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/terminal/messages") {
        const body = JSON.parse(init?.body as string) as { text: string };
        posts.push(body);
        return Promise.resolve(
          Response.json(
            { message: message(3, "owner", body.text), reply: null },
            { status: 201 },
          ),
        );
      }
      if (url === "/api/terminal") {
        return Promise.resolve(Response.json(chat));
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

const entries = () =>
  within(screen.getByRole("log", { name: "Chat with the AI" }))
    .queryAllByRole("listitem")
    .map((item) => [item.dataset["kind"], item.textContent]);

describe("the Terminal", () => {
  it("is in the navigation, and shows the conversation so far", async () => {
    stubServer(
      terminal([message(1, "owner", "Hi"), message(2, "reply", "Hello.")]),
    );
    render(
      <App
        router={createAppRouter(
          createMemoryHistory({ initialEntries: ["/terminal"] }),
        )}
        queryClient={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      />,
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Terminal" }),
    ).toBeDefined();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(nav).getByRole("link", { name: "Terminal" }).getAttribute("href"),
    ).toBe("/terminal");
    await waitFor(() => {
      expect(entries()).toEqual([
        ["owner", "YouHi"],
        ["reply", "The AIclaude-opus-5-5Hello."],
      ]);
    });
    expect(streams.map(({ url }) => url)).toContain(
      "/api/terminal/stream?lastEventId=2",
    );
  });

  it("asks the Model chosen, and streams the reply in", async () => {
    stubServer(terminal([]));
    render(
      <App
        router={createAppRouter(
          createMemoryHistory({ initialEntries: ["/terminal"] }),
        )}
        queryClient={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      />,
    );
    const model = await screen.findByLabelText<HTMLSelectElement>("Model");
    await waitFor(() => {
      expect(model.value).toBe("claude-opus-5-5");
    });
    await userEvent.selectOptions(model, "gpt-5.5");
    await userEvent.type(
      screen.getByLabelText("Message the AI"),
      "Explain a monad{Enter}",
    );
    await waitFor(() => {
      expect(posts).toEqual([{ text: "Explain a monad", model: "gpt-5.5" }]);
    });
    expect(
      (await screen.findByRole("status", { name: "Connection" })).textContent,
    ).toBe("The AI is answering…");
    const stream = streams.findLast(({ url }) =>
      url.startsWith("/api/terminal/stream"),
    );
    act(() => {
      stream?.send({ type: "delta", replyTo: 3, text: "A monad " });
    });
    await waitFor(() => {
      expect(entries().at(-1)).toEqual([
        "pending",
        "The AI is writing…A monad  ▍",
      ]);
    });
    act(() => {
      stream?.send({
        type: "message",
        message: { ...message(4, "reply", "A monad is…"), model: "gpt-5.5" },
      });
    });
    await waitFor(() => {
      expect(entries()).toEqual([
        ["owner", "YouExplain a monad"],
        ["reply", "The AIgpt-5.5A monad is…"],
      ]);
    });
  });
});

describe("the Terminal's status line", () => {
  const totals = (tokens: number) => ({
    requests: 1,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokens,
    estimatedCostUsd: 0,
  });
  const subscription = (fiveHour: number): AiAccount => ({
    id: "work",
    name: "Work",
    aiProvider: "Claude",
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
      weekly: null,
    },
    fiveHourPauseThreshold: null,
    weeklyPauseThreshold: null,
    forcedModel: null,
    extraUsage: false,
    createdAt: "2026-10-09T11:00:00.000Z",
    updatedAt: "2026-10-09T11:00:00.000Z",
  });

  it("shows the Model, its Context Usage, its key's tokens today and this month, and the serving subscription, kept live", async () => {
    const state = {
      inputTokens: 50_000,
      today: 120_000,
      fiveHour: 30,
    };
    const chat = (): DirectChat => ({
      ...terminal([message(1, "owner", "Hi"), message(2, "reply", "Hello.")]),
      usage: {
        model: "claude-opus-5-5",
        inputTokens: state.inputTokens,
        contextWindow: 200_000,
        contextUsage: state.inputTokens / 200_000,
        aiAccountId: "work",
        updatedAt: "2026-10-10T12:00:02.000Z",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        switch (url) {
          case "/api/terminal":
            return Promise.resolve(Response.json(chat()));
          case "/api/office/token-caps":
            return Promise.resolve(
              Response.json({
                caps: { daily: 1_000_000, monthly: 10_000_000 },
                usage: { daily: totals(1), monthly: totals(1) },
                busiestAgents: { daily: null, monthly: null },
                floors: [],
                ownerTools: [
                  {
                    ownerTool: "Terminal",
                    usage: {
                      daily: totals(state.today),
                      monthly: totals(3_400_000),
                    },
                  },
                ],
              }),
            );
          case "/api/ai-accounts":
            return Promise.resolve(
              Response.json({ accounts: [subscription(state.fiveHour)] }),
            );
          case "/api/session":
            return Promise.resolve(
              Response.json({
                csrfToken: "csrf",
                expiresAt: "2026-10-15T12:00:00.000Z",
              }),
            );
          default:
            return Promise.resolve(Response.json({}, { status: 404 }));
        }
      }),
    );
    render(
      <App
        router={createAppRouter(
          createMemoryHistory({ initialEntries: ["/terminal"] }),
        )}
        queryClient={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      />,
    );
    const line = await screen.findByLabelText("The Terminal's usage");
    const meter = (name: string | RegExp) =>
      within(line).findByRole("meter", { name });
    expect((await meter("Context Usage")).getAttribute("aria-valuenow")).toBe(
      "25",
    );
    await waitFor(() => {
      expect(line.textContent).toContain("Tokens today120,000");
    });
    expect(line.textContent).toContain("Tokens this month3,400,000");
    expect(
      (await meter(/^5-hour window used/)).getAttribute("aria-valuenow"),
    ).toBe("30");
    expect(line.textContent).toContain("Served by Work");
    // The Model it asks, first in the line.
    expect(line.parentElement?.textContent).toContain("Modelclaude-opus-5-5");

    // A request of the Terminal's key, on the AI Gateway's live stream,
    // reads its Context Usage, tokens and account again.
    state.inputTokens = 100_000;
    state.today = 180_000;
    state.fiveHour = 45;
    const requests = streams.find(
      ({ url }) => url === "/api/gateway/requests/stream?ownerTool=Terminal",
    );
    expect(requests).toBeDefined();
    act(() => {
      requests?.send({ id: 7 });
    });
    await waitFor(async () => {
      expect((await meter("Context Usage")).getAttribute("aria-valuenow")).toBe(
        "50",
      );
    });
    await waitFor(() => {
      expect(line.textContent).toContain("Tokens today180,000");
    });
    await waitFor(async () => {
      expect(
        (await meter(/^5-hour window used/)).getAttribute("aria-valuenow"),
      ).toBe("45");
    });
  });
});

describe("withDirectFrame", () => {
  it("adds deltas to the reply being written, then replaces it with the message", () => {
    let chat = terminal([message(1, "owner", "Hi")]);
    chat = withDirectFrame(chat, { type: "pending", replyTo: 1, text: "He" });
    chat = withDirectFrame(chat, { type: "delta", replyTo: 1, text: "llo" });
    expect(chat.pending).toEqual([{ replyTo: 1, text: "Hello" }]);
    chat = withDirectFrame(chat, {
      type: "message",
      message: message(2, "reply", "Hello."),
    });
    expect(chat.pending).toEqual([]);
    expect(chat.messages.map(({ id }) => id)).toEqual([1, 2]);
    // A late delta for an answered message changes nothing.
    expect(
      withDirectFrame(chat, { type: "delta", replyTo: 1, text: "!" }),
    ).toBe(chat);
  });
});
