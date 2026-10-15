import { randomAvatar, type Notice } from "@ai-office/shared";
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

// The 2D Notice Board (PRD FR-48, FR-50) against a stubbed server, with
// the live event stream driven by the test.

const notice = (overrides: Partial<Notice> & { id: string }): Notice => ({
  kind: "info",
  title: "A Notice",
  floorId: "web-shop",
  agentId: null,
  issue: null,
  pullRequest: null,
  ciRunUrl: null,
  links: [],
  positions: [],
  actions: [],
  createdAt: "2026-10-08T12:00:00.000Z",
  dismissedAt: null,
  actedAt: null,
  actedOn: null,
  ...overrides,
});

const awaitingApproval = notice({
  id: "notice-1",
  kind: "action",
  title: "PR #14 awaiting your approval",
  agentId: "ada",
  issue: { number: 4, url: "https://github.com/adrianeyre/web-shop/issues/4" },
  pullRequest: {
    number: 14,
    url: "https://github.com/adrianeyre/web-shop/pull/14",
  },
  ciRunUrl: "https://github.com/adrianeyre/web-shop/actions/runs/99",
  links: [
    {
      label: "Round 1",
      url: "https://github.com/adrianeyre/web-shop/pull/14#pullrequestreview-7",
    },
  ],
  actions: [{ id: "approve_and_merge", label: "Approve and merge" }],
});

const blogOpened = notice({
  id: "notice-2",
  title: "PR #3 opened",
  floorId: "blog",
  pullRequest: { number: 3, url: "https://github.com/adrianeyre/blog/pull/3" },
});

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

interface Posted {
  readonly url: string;
  readonly body: unknown;
  readonly csrf: string | null;
}

function stubServer(initial: Notice[]) {
  const state = { notices: [...initial], failAction: false };
  const posts: Posted[] = [];
  const gets: string[] = [];
  const close = (id: string) => {
    state.notices = state.notices.filter((n) => n.id !== id);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({
          url,
          body: JSON.parse(init.body as string),
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        const [, , , id, verb] = url.split("/");
        if (verb === "act" && state.failAction) {
          return Promise.resolve(
            Response.json(
              {
                error: "action_failed",
                message: "The action failed, so the Notice stays: CI is red.",
              },
              { status: 502 },
            ),
          );
        }
        close(id ?? "");
        return Promise.resolve(Response.json({}));
      }
      if (url.startsWith("/api/notices")) {
        gets.push(url);
        const floorId = new URL(url, "http://office").searchParams.get(
          "floorId",
        );
        return Promise.resolve(
          Response.json({
            notices: state.notices.filter(
              (n) => floorId === null || n.floorId === floorId,
            ),
          }),
        );
      }
      if (url === "/api/floors") {
        return Promise.resolve(
          Response.json({
            floors: [floor("web-shop", "Web shop"), floor("blog", "Blog")],
          }),
        );
      }
      if (url === "/api/floors/web-shop/agents") {
        return Promise.resolve(
          Response.json({
            agents: [
              {
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
              },
            ],
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
  return {
    state,
    posts,
    gets,
    add(added: Notice) {
      state.notices = [added, ...state.notices];
    },
  };
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

const board = async () =>
  within(await screen.findByRole("list", { name: "Notices" }));

const itemTitled = async (title: string) => {
  const heading = await screen.findByRole("heading", { name: title });
  const item = heading.closest("li");
  if (item === null) {
    throw new Error(`"${title}" is not in a list item.`);
  }
  return within(item);
};

beforeEach(() => {
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

describe("the Notice Board", () => {
  it("lists every Floor's open Notices with their links and actions", async () => {
    stubServer([awaitingApproval, blogOpened]);
    renderAt("/notices");
    const notices = await board();
    expect(
      notices.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["PR #14 awaiting your approval", "PR #3 opened"]);

    const item = await itemTitled("PR #14 awaiting your approval");
    expect(item.getByText("Action")).toBeDefined();
    expect(await item.findByText("Web shop")).toBeDefined();
    const links = within(item.getByRole("list", { name: "Links" }));
    expect(
      links.getByRole("link", { name: "Issue #4" }).getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/issues/4");
    expect(
      links.getByRole("link", { name: "PR #14" }).getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/pull/14");
    expect(
      links.getByRole("link", { name: "CI run" }).getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/actions/runs/99");
    expect(
      links.getByRole("link", { name: "Round 1" }).getAttribute("href"),
    ).toBe(
      "https://github.com/adrianeyre/web-shop/pull/14#pullrequestreview-7",
    );
    expect(
      (await links.findByRole("link", { name: "Agent: Ada" })).getAttribute(
        "href",
      ),
    ).toBe("/?floor=web-shop&inspect=agent%3Aada");
    expect(
      item.getByRole("button", { name: "Approve and merge" }),
    ).toBeDefined();
    expect(item.getByRole("button", { name: "Dismiss" })).toBeDefined();

    const info = await itemTitled("PR #3 opened");
    expect(info.getByText("Info")).toBeDefined();
    expect(await info.findByText("Blog")).toBeDefined();
    // Info Notices offer no actions, only dismissal.
    expect(info.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Dismiss",
    ]);
  });

  it("shows a conflict between Roles with both positions side by side", async () => {
    const pull = "https://github.com/adrianeyre/web-shop/pull/2";
    stubServer([
      notice({
        id: "notice-3",
        kind: "action",
        title:
          "Review Loop conflict between Roles: QA failed PR #2 (#1) in QA round 2 as in round 1, though every reviewer approved it twice in a row.",
        pullRequest: { number: 2, url: pull },
        positions: [
          {
            label: "Reviewers: approved in rounds 1 and 2",
            text: "Grace: It does what the issue asks.\nQuinta: It does what the issue asks.",
            url: `${pull}#pullrequestreview-2`,
          },
          {
            label: "QA: failed in QA rounds 1 and 2",
            text: "Adding the same sku twice fails.\n\nSteps to reproduce:\n1. add('a')",
          },
        ],
      }),
      blogOpened,
    ]);
    renderAt("/notices");
    const item = await itemTitled(
      "Review Loop conflict between Roles: QA failed PR #2 (#1) in QA round 2 as in round 1, though every reviewer approved it twice in a row.",
    );
    const list = item.getByRole("list", { name: "Positions" });
    // Two columns wherever the Notice has the room.
    expect(list.className).toContain("@md:grid-cols-2");
    const [reviewers, qa, ...more] = within(list).getAllByRole("listitem");
    expect(more).toEqual([]);
    if (reviewers === undefined || qa === undefined) {
      throw new Error("Both positions are shown.");
    }
    expect(
      within(reviewers)
        .getByRole("link", { name: "Reviewers: approved in rounds 1 and 2" })
        .getAttribute("href"),
    ).toBe(`${pull}#pullrequestreview-2`);
    expect(reviewers.textContent).toContain(
      "Grace: It does what the issue asks.",
    );
    expect(
      within(qa).getByRole("heading", {
        name: "QA: failed in QA rounds 1 and 2",
      }),
    ).toBeDefined();
    expect(within(qa).queryByRole("link")).toBeNull();
    expect(qa.textContent).toContain("Steps to reproduce:");

    // A Notice that is not a conflict has none.
    const other = await itemTitled("PR #3 opened");
    expect(other.queryByRole("list", { name: "Positions" })).toBeNull();
  });

  it("says so when there are no Notices", async () => {
    stubServer([]);
    renderAt("/notices");
    expect(
      await screen.findByText("No Notices. Nothing needs you right now."),
    ).toBeDefined();
  });

  it("shows one Floor's Notices when a Floor is chosen", async () => {
    const { gets } = stubServer([awaitingApproval, blogOpened]);
    const router = renderAt("/notices");
    await board();
    const select = screen.getByLabelText("Floor");
    await screen.findByRole("option", { name: "Blog" });
    await userEvent.selectOptions(select, "blog");
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "PR #14 awaiting your approval",
        }),
      ).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "PR #3 opened" })).toBeDefined();
    expect(router.state.location.search).toEqual({ floorId: "blog" });
    expect(gets).toContain("/api/notices?floorId=blog");

    await userEvent.selectOptions(select, "");
    expect(
      await screen.findByRole("heading", {
        name: "PR #14 awaiting your approval",
      }),
    ).toBeDefined();
    expect(router.state.location.search).toEqual({});
  });

  it("dismisses a Notice, which leaves the board", async () => {
    const { posts } = stubServer([awaitingApproval, blogOpened]);
    renderAt("/notices");
    const item = await itemTitled("PR #3 opened");
    await waitFor(() => {
      expect(
        item.getByRole<HTMLButtonElement>("button", { name: "Dismiss" })
          .disabled,
      ).toBe(false);
    });
    await userEvent.click(item.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "PR #3 opened" }),
      ).toBeNull();
    });
    expect(posts).toEqual([
      { url: "/api/notices/notice-2/dismiss", body: {}, csrf: "csrf-token-1" },
    ]);
  });

  it("takes a Notice's action, which takes it off the board", async () => {
    const { posts } = stubServer([awaitingApproval]);
    renderAt("/notices");
    const item = await itemTitled("PR #14 awaiting your approval");
    const button = item.getByRole("button", { name: "Approve and merge" });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(button);
    expect(
      await screen.findByText("No Notices. Nothing needs you right now."),
    ).toBeDefined();
    expect(posts).toEqual([
      {
        url: "/api/notices/notice-1/act",
        body: { action: "approve_and_merge" },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("keeps a Notice whose action failed, saying why", async () => {
    const { state } = stubServer([awaitingApproval]);
    state.failAction = true;
    renderAt("/notices");
    const item = await itemTitled("PR #14 awaiting your approval");
    const button = item.getByRole("button", { name: "Approve and merge" });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(button);
    expect((await item.findByRole("alert")).textContent).toBe(
      "The action failed, so the Notice stays: CI is red.",
    );
    expect(
      screen.getByRole("heading", { name: "PR #14 awaiting your approval" }),
    ).toBeDefined();
  });

  it("shows a raised Notice as soon as the stream says so", async () => {
    const server = stubServer([blogOpened]);
    renderAt("/notices");
    await board();
    const stream = streams.find(({ url }) => url.includes("notice.raised"));
    // The same stream brings Floors added, archived and renamed, for the
    // names the Notices are shown with.
    expect(stream?.url).toBe(
      "/api/events/stream?type=floor.archived%2Cfloor.created%2Cfloor.renamed%2Cnotice.acted_on%2Cnotice.dismissed%2Cnotice.raised",
    );
    server.add(awaitingApproval);
    act(() => {
      stream?.send({
        id: 7,
        occurredAt: "2026-10-08T12:00:05.000Z",
        event: {
          type: "notice.raised",
          version: 1,
          noticeId: "notice-1",
          kind: "action",
          title: "PR #14 awaiting your approval",
          floorId: "web-shop",
        },
      });
    });
    expect(
      await screen.findByRole("heading", {
        name: "PR #14 awaiting your approval",
      }),
    ).toBeDefined();
  });

  it("brings up the Notice a link names", async () => {
    stubServer([awaitingApproval, blogOpened]);
    renderAt("/notices?notice=notice-2");
    await board();
    const highlighted = screen
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("aria-current") === "true");
    expect(highlighted.map((item) => item.id)).toEqual(["notice-2"]);
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("notice-2");
    });
  });

  it("links an action taken on a page of AI Office there, without acting on the Notice", async () => {
    const { posts } = stubServer([
      notice({
        id: "notice-3",
        kind: "action",
        title: "Re-authentication needed: Claude Max",
        floorId: null,
        actions: [
          {
            id: "reauthenticate_ai_account",
            label: "Re-authenticate",
            href: "/ai-settings?reauthenticate=account-max",
          },
        ],
      }),
    ]);
    const user = userEvent.setup();
    const router = renderAt("/notices");
    const item = await itemTitled("Re-authentication needed: Claude Max");
    const link = item.getByRole("link", { name: "Re-authenticate" });
    expect(link.getAttribute("href")).toBe(
      "/ai-settings?reauthenticate=account-max",
    );

    await user.click(link);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/ai-settings");
    });
    expect(router.state.location.search).toEqual({
      reauthenticate: "account-max",
    });
    expect(posts).toEqual([]);
  });
});
