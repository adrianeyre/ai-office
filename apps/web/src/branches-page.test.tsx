import {
  randomAvatar,
  type BranchLane,
  type FloorBranches,
} from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
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

// The Branches page against a stubbed server, with the live event stream
// driven by the test.

const floor = (id: string, name: string) => ({
  id,
  name,
  repository: `adrianeyre/${id}`,
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
});

const sha = (letter: string) => letter.repeat(40);
const commit = (letter: string, message: string, authoredAt: string) => ({
  sha: sha(letter),
  message,
  author: "Adrian Eyre",
  agent: "Ada (coder, Claude claude-opus-5-5)",
  authoredAt,
  url: `https://github.com/adrianeyre/web-shop/commit/${sha(letter)}`,
});

const basket: BranchLane = {
  name: "ai-office/4-add-a-basket",
  url: "https://github.com/adrianeyre/web-shop/tree/ai-office/4-add-a-basket",
  headSha: sha("c"),
  aheadBy: 3,
  behindBy: 12,
  mergeBase: {
    ...commit("a", "Initial commit", "2026-10-11T09:00:00.000Z"),
    agent: null,
  },
  commits: [
    commit("b", "Add a basket", "2026-10-11T10:00:00.000Z"),
    commit("c", "Total the basket", "2026-10-11T11:00:00.000Z"),
  ],
  lastCommitAt: "2026-10-11T11:00:00.000Z",
  likelyToConflict: false,
  issue: {
    number: 4,
    title: "Add a basket",
    url: "https://github.com/adrianeyre/web-shop/issues/4",
  },
  batch: null,
  grillingSession: null,
  pullRequest: {
    number: 14,
    title: "Add a basket",
    url: "https://github.com/adrianeyre/web-shop/pull/14",
    draft: false,
  },
  ci: "success",
  work: {
    kind: "agent",
    agentId: "ada",
    name: "Ada",
    role: "coder",
    roleName: "coder",
    avatar: randomAvatar(() => 0.5, []),
  },
};

const checkout: BranchLane = {
  ...basket,
  name: "ai-office/7-checkout",
  url: "https://github.com/adrianeyre/web-shop/tree/ai-office/7-checkout",
  headSha: sha("d"),
  aheadBy: 1,
  behindBy: 25,
  commits: [commit("d", "Start the checkout", "2026-10-11T12:00:00.000Z")],
  lastCommitAt: "2026-10-11T12:00:00.000Z",
  likelyToConflict: true,
  issue: {
    number: 7,
    title: "Checkout",
    url: "https://github.com/adrianeyre/web-shop/issues/7",
  },
  pullRequest: null,
  ci: "failure",
  work: { kind: "stage", stage: "needs-review" },
};

const branchesOf = (floorId: string, lanes: BranchLane[]): FloorBranches => ({
  floorId,
  repository: `adrianeyre/${floorId}`,
  defaultBranch: {
    name: "main",
    sha: sha("f"),
    url: `https://github.com/adrianeyre/${floorId}/tree/main`,
  },
  lanes,
  fetchedAt: "2026-10-12T09:00:00.000Z",
});

function stubServer() {
  const state: {
    branches: Record<string, FloorBranches | { status: number; body: object }>;
  } = {
    branches: {
      "web-shop": branchesOf("web-shop", [basket]),
      blog: branchesOf("blog", []),
    },
  };
  const gets: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      gets.push(url);
      const branches = /^\/api\/floors\/([^/]+)\/branches$/.exec(url);
      if (branches !== null) {
        const answer = state.branches[branches[1] ?? ""];
        if (answer === undefined) {
          return Promise.resolve(Response.json({}, { status: 404 }));
        }
        return Promise.resolve(
          "status" in answer
            ? Response.json(answer.body, { status: answer.status })
            : Response.json(answer),
        );
      }
      if (url === "/api/floors") {
        return Promise.resolve(
          Response.json({
            floors: [floor("web-shop", "Web shop"), floor("blog", "Blog")],
          }),
        );
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
  return { state, gets };
}

/** The live event streams the page opened, newest last. */
let streams: (EventSourceLike & { url: string; send(data: unknown): void })[];

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

const table = async () =>
  within(await screen.findByRole("table", { name: /AI Office branches/ }));

const rowOf = async (branch: string) => {
  const header = await (
    await table()
  ).findByRole("rowheader", {
    name: new RegExp(branch),
  });
  const row = header.closest("tr");
  if (row === null) {
    throw new Error(`${branch} is not in a row.`);
  }
  return within(row);
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
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

describe("the Branches page", () => {
  it("is in the main menu", async () => {
    stubServer();
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await userEvent.click(within(nav).getByRole("link", { name: "Branches" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Branches" }),
    ).toBeTruthy();
  });

  it("opens on the first Floor, puts it in the address, and shows each lane with its badge, issue, pull request, CI and Agent", async () => {
    stubServer();
    const router = renderAt("/branches");
    const row = await rowOf("ai-office/4-add-a-basket");
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ floor: "web-shop" });
    });
    expect(screen.getByLabelText<HTMLSelectElement>("Floor").value).toBe(
      "web-shop",
    );

    const badge = row.getByText("↑3 ↓12");
    expect(badge.closest("[title]")?.getAttribute("title")).toBe(
      "3 commits ahead of main, 12 behind",
    );
    expect(row.getByText("3 commits ahead of main, 12 behind")).toBeTruthy();
    expect(
      row.getByRole("link", { name: /#4 Add a basket/ }).getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/issues/4");
    expect(row.getByRole("link", { name: /#14/ }).getAttribute("href")).toBe(
      "https://github.com/adrianeyre/web-shop/pull/14",
    );
    expect(row.getByText("CI passed")).toBeTruthy();
    expect(row.getByRole("link", { name: "Ada" })).toBeTruthy();
    expect(row.getByText(/coder/)).toBeTruthy();
    expect(row.queryByText("Likely to conflict")).toBeNull();

    // The lane view: each commit a link to it, named for a screen reader,
    // shown beside its dot when focused.
    const lanes = screen.getByRole("group", { name: "Lanes off main" });
    const dots = within(lanes).getAllByRole("link");
    expect(dots.map((dot) => dot.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(
        /^ai-office\/4-add-a-basket: bbbbbbb Add a basket, by Adrian Eyre \(Agent: Ada \(coder, Claude claude-opus-5-5\)\), /,
      ),
      expect.stringMatching(
        /^ai-office\/4-add-a-basket: ccccccc Total the basket/,
      ),
    ]);
    dots[1]?.focus();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("ccccccc");
    expect(tooltip.textContent).toContain("Total the basket");
    expect(tooltip.textContent).toContain("Adrian Eyre");
    expect(dots[1]?.getAttribute("aria-describedby")).toBe(tooltip.id);
  });

  it("marks a lane far behind as likely to conflict, and says what waits where no Agent works", async () => {
    const { state } = stubServer();
    state.branches["web-shop"] = branchesOf("web-shop", [basket, checkout]);
    renderAt("/branches?floor=web-shop");
    const row = await rowOf("ai-office/7-checkout");
    expect(row.getByText("Likely to conflict")).toBeTruthy();
    expect(row.getByText("Waiting in Review")).toBeTruthy();
    expect(row.getByText("CI failed")).toBeTruthy();
    expect(row.getByText("None open")).toBeTruthy();
    expect(
      screen.getByText(
        /1 branch is likely to conflict: more than 20 commits behind main/,
      ),
    ).toBeTruthy();
  });

  it("shows a one-pull-request Batch's shared branch as one heavier lane, with the issue at work now and where each of its issues stands", async () => {
    const { state } = stubServer();
    const shared: BranchLane = {
      ...checkout,
      name: "ai-office/batch-7",
      url: "https://github.com/adrianeyre/web-shop/tree/ai-office/batch-7",
      likelyToConflict: false,
      issue: {
        number: 9,
        title: "Totals",
        url: "https://github.com/adrianeyre/web-shop/issues/9",
      },
      batch: {
        id: 7,
        issues: [
          { number: 8, stage: "ready-to-merge" },
          { number: 9, stage: "needs-review" },
          { number: 10, stage: null },
        ],
      },
    };
    state.branches["web-shop"] = branchesOf("web-shop", [shared]);
    renderAt("/branches?floor=web-shop");
    const row = await rowOf("ai-office/batch-7");
    expect(row.getByText(/Batch 7, one pull request/)).toBeTruthy();
    expect(row.getByRole("link", { name: /#9 Totals/ })).toBeTruthy();
    const issues = row.getByRole("list", {
      name: "Batch 7's issues, in order",
    });
    expect(
      within(issues)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["#8 Ready to merge", "#9 Review", "#10 to start"]);
    expect(
      document
        .querySelector('path[stroke-width="4"]')
        ?.getAttribute("stroke-dasharray"),
    ).toBeNull();
  });

  it("switches Floors from the selector, updating the address and the lanes, and remembers the Floor picked", async () => {
    const { gets } = stubServer();
    const router = renderAt("/branches?floor=web-shop");
    await rowOf("ai-office/4-add-a-basket");
    await userEvent.selectOptions(screen.getByLabelText("Floor"), "blog");
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ floor: "blog" });
    });
    // A Floor with no AI Office branches says so.
    expect(
      await screen.findByText(/Blog has no AI Office branches/),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(gets).toContain("/api/floors/blog/branches");
    expect(localStorage.getItem("ai-office:branches-floor")).toBe("blog");

    // Opened again without a Floor in the address: the one last picked.
    cleanup();
    const again = renderAt("/branches");
    await waitFor(() => {
      expect(again.state.location.search).toEqual({ floor: "blog" });
    });
  });

  it("shows a GitHub error plainly, keeps the rest of the page usable, and tries again", async () => {
    const { state } = stubServer();
    state.branches["web-shop"] = {
      status: 502,
      body: {
        error: "github_unavailable",
        message:
          "GitHub could not be asked: GitHub answered 403: API rate limit exceeded",
      },
    };
    renderAt("/branches?floor=web-shop");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Web shop's branches could not be read.",
    );
    expect(alert.textContent).toContain("API rate limit exceeded");

    // The selector still works.
    await userEvent.selectOptions(screen.getByLabelText("Floor"), "blog");
    expect(
      await screen.findByText(/Blog has no AI Office branches/),
    ).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Floor"), "web-shop");
    state.branches["web-shop"] = branchesOf("web-shop", [basket]);
    await userEvent.click(
      await screen.findByRole("button", { name: "Try again" }),
    );
    await rowOf("ai-office/4-add-a-basket");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the lanes again when GitHub says the repository had a push, without a reload", async () => {
    const { state, gets } = stubServer();
    renderAt("/branches?floor=web-shop");
    await rowOf("ai-office/4-add-a-basket");
    const stream = streams.find((source) =>
      source.url.includes("repository.changed"),
    );
    expect(stream?.url).toContain("floorId=web-shop");
    const before = gets.filter((url) => url.endsWith("/branches")).length;

    state.branches["web-shop"] = branchesOf("web-shop", [
      { ...basket, aheadBy: 4, headSha: sha("e") },
      checkout,
    ]);
    stream?.send({
      id: 41,
      occurredAt: "2026-10-12T09:01:00.000Z",
      event: {
        type: "repository.changed",
        version: 1,
        floorId: "web-shop",
        change: "push",
      },
    });
    // Several at once are read once.
    stream?.send({
      id: 42,
      occurredAt: "2026-10-12T09:01:00.000Z",
      event: {
        type: "repository.changed",
        version: 1,
        floorId: "web-shop",
        change: "check_suite",
      },
    });
    await waitFor(async () => {
      expect(
        (await rowOf("ai-office/4-add-a-basket")).getByText("↑4 ↓12"),
      ).toBeTruthy();
    });
    expect(await rowOf("ai-office/7-checkout")).toBeTruthy();
    expect(gets.filter((url) => url.endsWith("/branches")).length).toBe(
      before + 1,
    );
  });
});
