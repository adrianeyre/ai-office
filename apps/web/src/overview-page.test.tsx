import type { WorkingNow } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { eventSources } from "./event-stream.ts";
import { elapsedText } from "./overview-page.tsx";
import { createAppRouter } from "./router.tsx";

// The Overview page against a stubbed server: every Agent's work and
// Manager's answer, and stopping one once the Owner confirms.

const working = (): WorkingNow => ({
  work: [
    {
      id: 11,
      floorId: "web-shop",
      floorName: "Web shop",
      repository: "adrianeyre/web-shop",
      issue: 4,
      stage: "needs-work",
      status: "running",
      agentId: "ada",
      agentName: "Ada",
      role: "coder",
      queuedAt: "2026-10-16T09:00:00.000Z",
      startedAt: "2026-10-16T09:01:00.000Z",
    },
    {
      id: 12,
      floorId: "blog",
      floorName: "Blog",
      repository: "adrianeyre/blog",
      issue: 9,
      stage: "needs-review",
      status: "queued",
      agentId: "rex",
      agentName: "Rex",
      role: "reviewer",
      queuedAt: "2026-10-16T09:02:00.000Z",
      startedAt: null,
    },
  ],
  managers: [
    {
      floorId: "web-shop",
      floorName: "Web shop",
      agentId: "max",
      agentName: "Max",
      phase: "writing",
      since: "2026-10-16T09:03:00.000Z",
    },
  ],
});

function stubServer() {
  const state = { now: working() };
  const posts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(url);
        const work = /^\/api\/working-now\/work\/(\d+)\/stop$/.exec(url);
        if (work !== null) {
          state.now = {
            ...state.now,
            work: state.now.work.filter(({ id }) => id !== Number(work[1])),
          };
          return Promise.resolve(Response.json(state.now));
        }
        if (url === "/api/working-now/managers/web-shop/stop") {
          // It had finished meanwhile.
          state.now = { ...state.now, managers: [] };
          return Promise.resolve(
            Response.json({ error: "manager_not_working" }, { status: 404 }),
          );
        }
      }
      if (url === "/api/working-now") {
        return Promise.resolve(Response.json(state.now));
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-17T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { state, posts };
}

function renderAt(path: string) {
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(eventSources, "open").mockImplementation(() => ({
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    close: () => undefined,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("how long something has gone on", () => {
  it("is short, in its largest units", () => {
    const at = Date.parse("2026-10-16T09:00:00.000Z");
    const since = (seconds: number) =>
      elapsedText(new Date(at - seconds * 1000).toISOString(), at);
    expect(since(-5)).toBe("0s");
    expect(since(45)).toBe("45s");
    expect(since(12 * 60 + 5)).toBe("12m");
    expect(since(3 * 3600)).toBe("3h");
    expect(since(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(since(2 * 86400 + 4 * 3600)).toBe("2d 4h");
  });
});

describe("the Overview page", () => {
  it("shows every Agent's work and Manager's answer, by Floor", async () => {
    stubServer();
    renderAt("/overview");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Overview" }),
    ).toBeDefined();
    const agents = await screen.findByRole("table", { name: "Agents' work" });
    expect(
      within(agents)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Adacoder", "Rexreviewer"]);
    expect(
      within(agents).getByRole("link", { name: "#4" }).getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/issues/4");
    const managers = screen.getByRole("table", { name: "Managers answering" });
    expect(within(managers).getByText("Writing a reply")).toBeDefined();
    expect(
      screen.getAllByRole("definition").map((count) => count.textContent),
    ).toEqual(["1", "1", "1"]);

    await userEvent.selectOptions(screen.getByLabelText("Floor"), "blog");
    expect(
      within(screen.getByRole("table", { name: "Agents' work" }))
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Rexreviewer"]);
    expect(screen.getByText("No Manager is answering.")).toBeDefined();
  });

  it("stops one piece of work once the Owner confirms, the rest carrying on", async () => {
    const { posts } = stubServer();
    renderAt("/overview");
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Stop Ada's work on #4 in Web shop",
      }),
    );
    // Asked first; keeping it going stops nothing.
    const [keep] = screen.getAllByRole("button", { name: "Keep it going" });
    if (keep === undefined) {
      throw new Error("The dialog cannot be closed.");
    }
    await userEvent.click(keep);
    expect(posts).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Stop Ada's work on #4 in Web shop" }),
    );
    expect(
      screen.getByText(
        /Its sandbox is stopped at once and the work is cancelled/,
      ),
    ).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped Ada's work on #4.")).toBeDefined();
    expect(posts).toEqual(["/api/working-now/work/11/stop"]);
    expect(
      within(screen.getByRole("table", { name: "Agents' work" }))
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Rexreviewer"]);
  });

  it("says so when what was to stop had already finished", async () => {
    stubServer();
    renderAt("/overview");
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop Max on Web shop" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Max had already finished.")).toBeDefined();
    expect(await screen.findByText("No Manager is answering.")).toBeDefined();
  });

  it("is in the navigation, after the Office", async () => {
    stubServer();
    renderAt("/overview");
    const link = await screen.findByRole("link", { name: "Overview" });
    expect(link.getAttribute("href")).toBe("/overview");
  });
});
