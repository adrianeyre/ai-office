import type { WorkingNow } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { agoText, elapsedText, matchesQuery } from "./overview-page.tsx";
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
      issueTitle: "Add a basket",
      stage: "needs-work",
      status: "running",
      agentId: "ada",
      agentName: "Ada",
      role: "coder",
      queuedAt: "2026-10-16T09:00:00.000Z",
      startedAt: "2026-10-16T09:01:00.000Z",
      latest: {
        kind: "tool",
        text: "Bash pnpm test",
        at: "2026-10-16T09:02:00.000Z",
      },
    },
    {
      id: 12,
      floorId: "blog",
      floorName: "Blog",
      repository: "adrianeyre/blog",
      issue: 9,
      issueTitle: null,
      stage: "needs-review",
      status: "queued",
      agentId: "rex",
      agentName: "Rex",
      role: "reviewer",
      queuedAt: "2026-10-16T09:02:00.000Z",
      startedAt: null,
      latest: null,
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

/** The live event streams the page opened, newest last. */
let streams: (EventSourceLike & { send(data: unknown): void })[];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
  streams = [];
  vi.spyOn(eventSources, "open").mockImplementation(() => {
    const source = {
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
    expect(agoText(at - 3000, at)).toBe("just now");
    expect(agoText(at - 42_000, at)).toBe("42s ago");
  });
});

describe("finding a row", () => {
  it("matches its Agent, Role, Floor, issue number or title, in any case", () => {
    const [ada, rex] = working().work;
    if (ada === undefined || rex === undefined) {
      throw new Error("The fixture has two pieces of work.");
    }
    for (const query of ["ADA", "coder", "web", "#4", "4", "basket", "pnpm"]) {
      expect(matchesQuery(ada, query)).toBe(true);
    }
    expect(matchesQuery(rex, "basket")).toBe(false);
    expect(matchesQuery(rex, " ")).toBe(true);
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
      within(agents)
        .getByRole("link", { name: "#4 Add a basket" })
        .getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/issues/4");
    const managers = screen.getByRole("table", { name: "Managers answering" });
    expect(within(managers).getByText("Writing a reply")).toBeDefined();
    const counts = screen.getByRole("group", {
      name: "Counts, and filters by status",
    });
    expect(counts.textContent).toContain("Agents working1");
    expect(counts.textContent).toContain("Queued1");
    expect(counts.textContent).toContain("Managers answering1");

    await userEvent.selectOptions(screen.getByLabelText("Floor"), "blog");
    expect(
      within(screen.getByRole("table", { name: "Agents' work" }))
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Rexreviewer"]);
    expect(
      screen.getByText("No Manager is answering among those shown."),
    ).toBeDefined();
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

  it("shows each issue's title and what its sandbox did last, as it happens", async () => {
    stubServer();
    renderAt("/overview");
    const agents = await screen.findByRole("table", { name: "Agents' work" });
    expect(
      within(agents).getByRole("link", { name: "#4 Add a basket" }),
    ).toBeDefined();
    expect(
      within(agents).getByText("Bash pnpm test", { exact: false }),
    ).toBeDefined();
    expect(
      within(agents)
        .getByRole("link", { name: /^Watch/ })
        .getAttribute("href"),
    ).toBe("/floors/web-shop/agents/ada");
    // A queued piece of work has nothing to watch.
    expect(
      within(agents).queryByRole("link", { name: /Watch Rex/ }),
    ).toBeNull();

    const stream = streams.at(-1);
    stream?.onopen?.(new Event("open"));
    stream?.send({
      id: 50,
      occurredAt: new Date().toISOString(),
      event: {
        type: "sandbox.text",
        version: 1,
        floorId: "web-shop",
        agentId: "ada",
        issue: 4,
        sandboxId: "sbx-1",
        text: "Totting up the basket.",
      },
    });
    expect(
      await within(agents).findByText("Totting up the basket."),
    ).toBeDefined();
    expect(await screen.findByText("Live")).toBeDefined();
  });

  it("finds, and filters by status, keeping both in its address", async () => {
    stubServer();
    renderAt("/overview?status=queued");
    const agents = await screen.findByRole("table", { name: "Agents' work" });
    expect(
      within(agents)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Rexreviewer"]);
    // Managers are not work: they are not shown by status.
    expect(
      screen.queryByRole("table", { name: "Managers answering" }),
    ).toBeNull();
    const queued = screen.getByRole("button", { name: /^Queued/ });
    expect(queued.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(queued);
    expect(
      await screen.findByRole("table", { name: "Managers answering" }),
    ).toBeDefined();

    await userEvent.type(screen.getByLabelText("Find"), "nobody");
    expect(
      await screen.findByText("Nothing matches these filters."),
    ).toBeDefined();
    await userEvent.click(
      screen.getByRole("button", { name: "Clear the filters" }),
    );
    expect(
      within(screen.getByRole("table", { name: "Agents' work" }))
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Adacoder", "Rexreviewer"]);
  });

  it("is in the navigation, after the Office", async () => {
    stubServer();
    renderAt("/overview");
    const link = await screen.findByRole("link", { name: "Overview" });
    expect(link.getAttribute("href")).toBe("/overview");
  });
});
