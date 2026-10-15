import type { OfficeEvent } from "@ai-office/events/schema";
import type { StreamedEvent } from "@ai-office/events/stream";
import { randomAvatar, type AgentContextUsage } from "@ai-office/shared";
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

import { LiveEntry } from "./agent-live-view.tsx";
import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { createAppRouter } from "./router.tsx";

// One Agent's live view (PRD FR-58): each kind of event it shows, the
// events streaming in, and auto-scroll pausing while the Owner reads back.

const subject = {
  version: 1,
  floorId: "web-shop",
  agentId: "ada",
  issue: 4,
  sandboxId: "sbx-1",
} as const;

const stored = (id: number, event: OfficeEvent): StreamedEvent => ({
  id,
  occurredAt: new Date(Date.UTC(2026, 9, 8, 12, 0, id)).toISOString(),
  event,
});

const text = (id: number, words: string) =>
  stored(id, { type: "sandbox.text", ...subject, text: words });

function renderEntry(event: OfficeEvent) {
  return render(<LiveEntry stored={stored(1, event)} />);
}

describe("each kind of event in the live view", () => {
  afterEach(cleanup);

  it("shows the Agent's terminal output as it is", () => {
    const { container } = renderEntry({
      type: "sandbox.text",
      ...subject,
      text: "Running the tests.\n  12 passed",
    });
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("Running the tests.\n  12 passed");
  });

  it("shows a tool call with its tool and argument", () => {
    renderEntry({
      type: "sandbox.tool_call",
      ...subject,
      name: "Bash",
      args: "pnpm test",
    });
    expect(screen.getByText("Bash").textContent).toBe("Bash");
    expect(screen.getByText(/Tool call:/).parentElement?.textContent).toBe(
      "Tool call: ▸ Bash pnpm test",
    );
  });

  it("shows a file diff with its path, counts and lines", () => {
    renderEntry({
      type: "sandbox.diff",
      ...subject,
      path: "src/basket.ts",
      diff: "-export const total = 0;\n+export const total = sum(items);\n@@\n+export const n = 1;",
      added: 2,
      removed: 1,
    });
    const figure = screen.getByRole("figure");
    expect(within(figure).getByText("src/basket.ts")).toBeDefined();
    expect(within(figure).getByText("+2")).toBeDefined();
    expect(within(figure).getByText("−1")).toBeDefined();
    const lines = [...figure.querySelectorAll("pre > span")];
    expect(lines.map((line) => line.textContent)).toEqual([
      "-export const total = 0;",
      "+export const total = sum(items);",
      "@@",
      "+export const n = 1;",
    ]);
    expect(lines[0]?.className).toContain("text-red-300");
    expect(lines[1]?.className).toContain("text-emerald-300");
  });

  it("shows a model call with its tokens", () => {
    renderEntry({
      type: "model_call.completed",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      issue: 4,
      aiAccount: "claude-1",
      aiProvider: "Claude",
      model: "claude-opus-5-5",
      status: 200,
      latencyMs: 812,
      inputTokens: 12_000,
      outputTokens: 300,
      cacheReadTokens: 9000,
      cacheWriteTokens: null,
    });
    expect(screen.getByText(/Model call/).textContent).toBe(
      "Model call · Claude claude-opus-5-5 · 12,000 in · 300 out · 9,000 cache read · 812 ms",
    );
  });

  it("shows the sandbox starting and stopping, and the Agent's status", () => {
    renderEntry({
      type: "sandbox.started",
      ...subject,
      branch: "ai-office/4-add-a-basket",
    });
    renderEntry({
      type: "sandbox.stopped",
      ...subject,
      outcome: "timed_out",
      exitCode: null,
    });
    renderEntry({
      type: "agent.status_changed",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      status: "blocked",
      issue: 4,
      reason: "CI is red",
    });
    expect(
      screen.getByText("Sandbox started for #4 on ai-office/4-add-a-basket"),
    ).toBeDefined();
    expect(screen.getByText("Sandbox for #4 timed out")).toBeDefined();
    expect(screen.getByText("Now blocked on #4: CI is red")).toBeDefined();
  });
});

const ada = {
  id: "ada",
  floorId: "web-shop",
  name: "Ada",
  role: "coder",
  stage: "work",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  freshStartThreshold: null,
  enabled: true,
  avatar: randomAvatar(() => 0.5, []),
  tokenCaps: { daily: null, monthly: null },
  createdAt: "2026-10-08T12:00:00.000Z",
  leavingAt: null,
  contractor: null,
};

interface FakeStream extends Omit<EventSourceLike, "readyState"> {
  readyState: number;
  readonly url: string;
  send(data: unknown): void;
}

let streams: FakeStream[];
let historyUrls: string[];

function stubServer(
  backlog: StreamedEvent[],
  contextUsage: readonly AgentContextUsage[] = [],
) {
  historyUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/events?")) {
        historyUrls.push(url);
        return Promise.resolve(
          Response.json({ events: backlog.toReversed(), nextBefore: null }),
        );
      }
      if (url === "/api/floors/web-shop/agents") {
        return Promise.resolve(Response.json({ agents: [ada] }));
      }
      if (url === "/api/floors/web-shop/context-usage") {
        return Promise.resolve(Response.json({ agents: contextUsage }));
      }
      if (url === "/api/floors/web-shop") {
        return Promise.resolve(
          Response.json({
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
          }),
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

function renderPage() {
  render(
    <App
      router={createAppRouter(
        createMemoryHistory({
          initialEntries: ["/floors/web-shop/agents/ada"],
        }),
      )}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
}

const lines = () =>
  within(screen.getByRole("log", { name: "Live activity" }))
    .queryAllByRole("listitem")
    .map((item) => item.textContent);

const liveStream = (): FakeStream => {
  const stream = streams.find(({ url }) => url.includes("agentId=ada"));
  if (stream === undefined) {
    throw new Error("The live view opened no stream.");
  }
  return stream;
};

/** The log as if it laid out: each line 20px tall, 100px on screen. */
function layOut(log: HTMLElement) {
  Object.defineProperty(log, "clientHeight", { value: 100 });
  Object.defineProperty(log, "scrollHeight", {
    get: () => 20 * log.querySelectorAll("li").length,
  });
}

describe("the Agent live view", () => {
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

  it("names the Agent, and starts with its recent activity, oldest first", async () => {
    stubServer([text(5, "Reading the issue."), text(6, "Writing a test.")]);
    renderPage();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Ada" }),
    ).toBeDefined();
    expect(
      (await screen.findByText(/Coder on/)).textContent.replaceAll(/\s+/g, " "),
    ).toBe("Coder on Web shop · Claude claude-opus-5-5");
    await waitFor(() => {
      expect(lines()).toEqual(["Reading the issue.", "Writing a test."]);
    });
    expect(historyUrls).toEqual([
      "/api/events?agentId=ada&type=agent.status_changed%2Csandbox.started%2Csandbox.stopped%2Csandbox.text%2Csandbox.tool_call%2Csandbox.diff%2Cmodel_call.completed&limit=200",
    ]);
  });

  it("streams new events in after the ones it started with", async () => {
    stubServer([text(5, "Reading the issue.")]);
    renderPage();
    await waitFor(() => {
      expect(lines()).toEqual(["Reading the issue."]);
    });
    const stream = liveStream();
    // Resuming right after the last event it read.
    expect(stream.url).toContain("lastEventId=5");
    act(() => {
      stream.onopen?.(new Event("open"));
      stream.send(
        stored(7, {
          type: "sandbox.tool_call",
          ...subject,
          name: "Bash",
          args: "pnpm test",
        }),
      );
      stream.send(text(8, "All green."));
    });
    await waitFor(() => {
      expect(lines()).toEqual([
        "Reading the issue.",
        "Tool call: ▸ Bash pnpm test",
        "All green.",
      ]);
    });
    expect(screen.getByRole("status", { name: "Connection" }).textContent).toBe(
      "Live",
    );
  });

  it("shows the Agent's Context Usage, colour-coded and kept live by its events", async () => {
    stubServer(
      [],
      [
        {
          agentId: "ada",
          floorId: "web-shop",
          issue: 4,
          model: "claude-opus-5-5",
          inputTokens: 124_000,
          contextWindow: 200_000,
          contextUsage: 0.62,
          updatedAt: "2026-10-08T12:00:00.000Z",
        },
      ],
    );
    renderPage();
    const meter = await screen.findByRole("meter", { name: "Context Usage" });
    expect(meter.getAttribute("aria-valuenow")).toBe("62");
    expect(meter.closest("[data-band]")?.getAttribute("data-band")).toBe(
      "amber",
    );

    const stream = streams.find(({ url }) =>
      url.includes("type=agent.context_usage"),
    );
    if (stream === undefined) {
      throw new Error("The page opened no Context Usage stream.");
    }
    expect(stream.url).toContain("floorId=web-shop");
    const usageEvent = (id: number, fields: Record<string, unknown>) =>
      stored(id, {
        type: "agent.context_usage",
        version: 1,
        floorId: "web-shop",
        agentId: "ada",
        issue: 4,
        ...fields,
      } as OfficeEvent);
    act(() => {
      stream.send(
        usageEvent(9, {
          active: true,
          model: "claude-opus-5-5",
          inputTokens: 172_000,
          contextWindow: 200_000,
          contextUsage: 0.86,
        }),
      );
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("meter", { name: "Context Usage" })
          .getAttribute("aria-valuenow"),
      ).toBe("86");
    });
    expect(
      screen
        .getByRole("meter", { name: "Context Usage" })
        .closest("[data-band]")
        ?.getAttribute("data-band"),
    ).toBe("red");

    act(() => {
      stream.send(usageEvent(10, { active: false, contextUsage: null }));
    });
    expect(
      await screen.findByLabelText("Context Usage: no session"),
    ).toBeDefined();
  });

  it("says when there is nothing yet", async () => {
    stubServer([]);
    renderPage();
    expect(
      await screen.findByText(
        "Nothing yet. What the Agent does appears here as it happens.",
      ),
    ).toBeDefined();
  });

  it("follows new events, pauses when scrolled up, and jumps back to the latest", async () => {
    stubServer(
      Array.from({ length: 10 }, (_, index) =>
        text(index + 1, `Line ${String(index + 1)}`),
      ),
    );
    renderPage();
    const log = await screen.findByRole("log", { name: "Live activity" });
    layOut(log);
    await waitFor(() => {
      expect(lines()).toHaveLength(10);
    });
    const send = (id: number) => {
      act(() => {
        liveStream().send(text(id, `Line ${String(id)}`));
      });
    };

    // Following: each new line scrolls to the bottom.
    send(11);
    await waitFor(() => {
      expect(log.scrollTop).toBe(220);
    });

    // The Owner scrolls up to read: new lines no longer move the view.
    log.scrollTop = 40;
    fireEvent.scroll(log);
    send(12);
    send(13);
    await waitFor(() => {
      expect(lines()).toHaveLength(13);
    });
    expect(log.scrollTop).toBe(40);
    const jump = screen.getByRole("button", {
      name: "Jump to latest (2 new)",
    });

    // Jumping back follows again.
    await userEvent.click(jump);
    expect(log.scrollTop).toBe(260);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
    send(14);
    await waitFor(() => {
      expect(log.scrollTop).toBe(280);
    });

    // Scrolling back down to the bottom by hand follows too.
    log.scrollTop = 0;
    fireEvent.scroll(log);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeDefined();
    log.scrollTop = 180;
    fireEvent.scroll(log);
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  });
});
