import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoleMemoryCard } from "./role-memory-card.tsx";

// A Floor's Role memory in its admin (PRD FR-55), against a stubbed
// server: each Role's accepted entries and the proposals waiting, which
// the Owner accepts or rejects, and accepted entries they remove.

const floor = {
  id: "web-shop",
  name: "Web shop",
  repository: "adrianeyre/web-shop",
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office" as const,
  defaultBranch: "main",
  setupCommand: "",
  testCommand: "",
  mergePolicy: "send_to_me" as const,
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
  createdAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
};

const entry = (
  id: number,
  role: string,
  text: string,
  status: string,
  agentId = "ada",
) => ({
  id,
  role,
  text,
  status,
  issue: 4,
  agentId,
  createdAt: "2026-10-09T09:00:00.000Z",
  decidedBy: status === "proposed" ? null : "owner",
  decidedAt: status === "proposed" ? null : "2026-10-09T10:00:00.000Z",
  reason: null as string | null,
});

function stubServer(more: readonly ReturnType<typeof entry>[] = []) {
  const state = {
    entries: [
      entry(1, "coder", "Write the failing test first.", "accepted"),
      entry(2, "coder", "Keep each commit to one change.", "proposed"),
      entry(3, "qa", "Run the tests twice.", "proposed", "quill"),
      ...more,
    ],
  };
  const calls: { method: string; url: string; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const action =
        /^\/api\/floors\/web-shop\/role-memory\/(\d+)(?:\/(accept|reject))?$/.exec(
          url,
        );
      if (action !== null && init?.method !== undefined) {
        calls.push({
          method: init.method,
          url,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        const id = Number(action[1]);
        const status =
          action[2] === "accept"
            ? "accepted"
            : action[2] === "reject"
              ? "rejected"
              : "removed";
        state.entries = state.entries.flatMap((candidate) =>
          candidate.id !== id
            ? [candidate]
            : status === "accepted"
              ? [{ ...candidate, status }]
              : [],
        );
        return Promise.resolve(Response.json({}));
      }
      if (url === "/api/floors/web-shop/role-memory") {
        return Promise.resolve(Response.json(state));
      }
      if (url === "/api/floors/web-shop/agents") {
        return Promise.resolve(Response.json({ agents: [] }));
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { calls };
}

const renderCard = (archivedAt: string | null = null) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RoleMemoryCard floor={{ ...floor, archivedAt }} />
    </QueryClientProvider>,
  );

const items = (name: string) =>
  Array.from(
    screen.getByRole("list", { name }).querySelectorAll("li"),
    ({ textContent }) => textContent,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a Floor's Role memory in its admin", () => {
  it("lists each Role's accepted entries and the proposals waiting", async () => {
    stubServer();
    renderCard();
    expect(await screen.findByRole("heading", { name: "coder" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "QA" })).toBeTruthy();
    expect(items("Accepted coder memory")).toEqual([
      "Write the failing test first.Remove",
    ]);
    expect(items("Proposed coder memory")).toEqual([
      "Keep each commit to one change. (An Agent, on #4)AcceptReject",
    ]);
    expect(items("Proposed QA memory")).toEqual([
      "Run the tests twice. (An Agent, on #4)AcceptReject",
    ]);
  });

  it("lists what the Manager recommends among the proposals waiting for the Owner, with its reason: only the Owner accepts (ADR 0005)", async () => {
    stubServer([
      {
        ...entry(
          4,
          "coder",
          "Run the linter before each commit.",
          "recommended",
        ),
        decidedBy: "manager",
        reason: "It holds for every coder here.",
      },
    ]);
    renderCard();
    expect(await screen.findByRole("heading", { name: "coder" })).toBeTruthy();
    expect(items("Accepted coder memory")).toEqual([
      "Write the failing test first.Remove",
    ]);
    expect(items("Proposed coder memory")).toEqual([
      "Keep each commit to one change. (An Agent, on #4)AcceptReject",
      "Run the linter before each commit. (An Agent, on #4; the Manager recommends it: It holds for every coder here)AcceptReject",
    ]);
  });

  it("accepts, rejects and removes entries as the Owner", async () => {
    const { calls } = stubServer();
    renderCard();
    await userEvent.click(
      await screen.findByRole("button", {
        name: 'Accept "Keep each commit to one change."',
      }),
    );
    await vi.waitFor(() => {
      expect(items("Accepted coder memory")).toHaveLength(2);
    });
    await userEvent.click(
      screen.getByRole("button", { name: 'Reject "Run the tests twice."' }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: 'Remove "Write the failing test first."',
      }),
    );
    await vi.waitFor(() => {
      expect(items("Accepted coder memory")).toEqual([
        "Keep each commit to one change.Remove",
      ]);
    });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/api/floors/web-shop/role-memory/2/accept",
        csrf: "csrf-token-1",
      },
      {
        method: "POST",
        url: "/api/floors/web-shop/role-memory/3/reject",
        csrf: "csrf-token-1",
      },
      {
        method: "DELETE",
        url: "/api/floors/web-shop/role-memory/1",
        csrf: "csrf-token-1",
      },
    ]);
    expect(screen.queryByRole("heading", { name: "QA" })).toBeNull();
  });

  it("is brought into view when the address names it, as the bookshelf's link does", async () => {
    stubServer();
    const scrolled: Element[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      function (this: HTMLElement) {
        scrolled.push(this);
      },
    );
    renderCard();
    await screen.findByRole("heading", { name: "coder" });
    expect(scrolled).toEqual([]);
    cleanup();

    window.history.replaceState(null, "", "#role-memory");
    try {
      renderCard();
      await screen.findByRole("heading", { name: "coder" });
      expect(scrolled.map(({ id }) => id)).toEqual(["role-memory"]);
      expect(
        within(scrolled[0] as HTMLElement).getByRole("heading", {
          name: "Role memory",
        }),
      ).toBeTruthy();
    } finally {
      window.history.replaceState(null, "", "#");
      vi.restoreAllMocks();
    }
  });

  it("is kept in view while the page above it grows, until the Owner scrolls", async () => {
    stubServer();
    let scrolls = 0;
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {
      scrolls += 1;
    });
    // The page's size, as the browser reports it to an observer.
    const grown: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          grown.push(callback);
        }
        observe() {
          return undefined;
        }
        disconnect() {
          grown.length = 0;
        }
      },
    );
    window.history.replaceState(null, "", "#role-memory");
    try {
      renderCard();
      await screen.findByRole("heading", { name: "coder" });
      expect(scrolls).toBe(1);
      // A card above it loads, and the page grows: back into view.
      grown.forEach((callback) => {
        callback();
      });
      expect(scrolls).toBe(2);
      // The Owner scrolls: the page is theirs.
      window.dispatchEvent(new WheelEvent("wheel"));
      expect(grown).toEqual([]);
    } finally {
      window.history.replaceState(null, "", "#");
      vi.restoreAllMocks();
    }
  });

  it("changes nothing on an archived Floor", async () => {
    stubServer();
    renderCard("2026-10-05T00:00:00.000Z");
    await screen.findByRole("heading", { name: "coder" });
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
    }
  });
});
