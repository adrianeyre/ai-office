import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browser } from "./api.ts";
import { App } from "./app.tsx";
import { brand } from "./brand/brand.ts";
import { createAppRouter } from "./router.tsx";
import { reloadNavigationPrefs } from "./navigation-prefs.ts";
import { resetLift, useLiftStore } from "./scene/lift-store.ts";
import { useUiStore } from "./ui-store.ts";

const healthy = { status: "ok", database: "up" };

function renderAt(path: string) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const session = {
  csrfToken: "csrf-token",
  expiresAt: "2026-10-15T12:00:00.000Z",
};

// The app is signed in; /health answers `body`.
const stubHealth = (body: unknown, status = 200) => {
  const fetch = vi.fn((url: string) =>
    Promise.resolve(
      url === "/api/session"
        ? Response.json(session)
        : Response.json(body, { status }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

beforeEach(() => {
  // The router restores scroll positions, which jsdom does not implement.
  vi.stubGlobal("scrollTo", vi.fn());
  stubHealth(healthy);
  useUiStore.setState({ navigationOpen: false });
  localStorage.clear();
  reloadNavigationPrefs();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pages = [
  { path: "/", link: "Office", heading: "Office - Lobby", title: "Office" },
  {
    path: "/api-keys",
    link: "API Key Management",
    heading: "API Key Management",
    title: "API Key Management",
  },
  {
    path: "/agent-settings",
    link: "Agent Settings",
    heading: "Agent Settings",
    title: "Agent Settings",
  },
  {
    path: "/notices",
    link: "Notices",
    heading: "Notice Board",
    title: "Notice Board",
  },
  {
    path: "/activity",
    link: "Activity",
    heading: "Activity",
    title: "Activity",
  },
  {
    path: "/terminal",
    link: "Terminal",
    heading: "Terminal",
    title: "Terminal",
  },
  {
    path: "/gateway",
    link: "Gateway",
    heading: "Gateway requests",
    title: "Gateway requests",
  },
  {
    path: "/analytics",
    link: "Analytics",
    heading: "Analytics",
    title: "Analytics",
  },
  {
    path: "/branches",
    link: "Branches",
    heading: "Branches",
    title: "Branches",
  },
  {
    path: "/ai-settings",
    link: "AI Settings",
    heading: "AI Settings",
    title: "AI Settings",
  },
  {
    path: "/floor-settings",
    link: "Floor Settings",
    heading: "Floor Settings",
    title: "Floor Settings",
  },
  {
    path: "/general-settings",
    link: "General Settings",
    heading: "General Settings",
    title: "General Settings",
  },
] as const;

describe("the app layout", () => {
  it("links to every page from the navigation", async () => {
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(
      links.map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Office", "/"],
      ["Overview", "/overview"],
      ["Notices", "/notices"],
      ["Activity", "/activity"],
      ["Terminal", "/terminal"],
      ["Gateway", "/gateway"],
      ["Analytics", "/analytics"],
      ["Branches", "/branches"],
      ["Agent Settings", "/agent-settings"],
      ["API Key Management", "/api-keys"],
      ["AI Settings", "/ai-settings"],
      ["Floor Settings", "/floor-settings"],
      ["General Settings", "/general-settings"],
    ]);
  });

  it("puts Floor Settings just before General Settings", async () => {
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labels.indexOf("Floor Settings")).toBeGreaterThan(-1);
    expect(labels.indexOf("General Settings")).toBe(
      labels.indexOf("Floor Settings") + 1,
    );
  });

  it("sends a Floor's old settings address to Floor Settings, keeping its hash", async () => {
    const router = renderAt("/admin/floors/web-shop#role-memory");
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/floor-settings/web-shop");
    });
    expect(router.state.location.hash).toBe("role-memory");
  });

  it("sends General Settings' old addresses to /general-settings, keeping their search and hash", async () => {
    for (const [old, path, search, hash] of [
      [
        "/admin#office-wide-memory",
        "/general-settings",
        "",
        "office-wide-memory",
      ],
      ["/admin/roles?role=coder", "/general-settings/roles", "?role=coder", ""],
      ["/admin/templates", "/general-settings/templates", "", ""],
      [
        "/admin/connections?connection=c1",
        "/general-settings/connections",
        "?connection=c1",
        "",
      ],
    ] as const) {
      const router = renderAt(old);
      await waitFor(() => {
        expect(router.state.location.pathname, old).toBe(path);
      });
      expect(router.state.location.searchStr, old).toBe(search);
      expect(router.state.location.hash, old).toBe(hash);
      cleanup();
    }
  });

  it("collapses to its icons, and remembers it in this browser", async () => {
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const collapse = screen.getByRole("button", { name: "Collapse the menu" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(collapse);
    expect(
      document.getElementById("navigation")?.hasAttribute("data-collapsed"),
    ).toBe(true);
    // Each item is still named, and its tooltip says what it is.
    const office = within(nav).getByRole("link", { name: "Office" });
    expect(office.getAttribute("title")).toBe("Office");
    expect(localStorage.getItem("ai-office:navigation-collapsed")).toBe("true");
    await userEvent.click(
      screen.getByRole("button", { name: "Expand the menu" }),
    );
    expect(
      document.getElementById("navigation")?.hasAttribute("data-collapsed"),
    ).toBe(false);
    expect(localStorage.getItem("ai-office:navigation-collapsed")).toBe(
      "false",
    );
  });

  it("is resized by dragging its edge or with the arrow keys, kept in this browser", async () => {
    renderAt("/");
    const edge = await screen.findByRole("separator", {
      name: "Resize the menu",
    });
    const aside = document.getElementById("navigation");
    expect(edge.getAttribute("aria-valuenow")).toBe("220");
    expect(aside?.style.getPropertyValue("--navigation-width")).toBe("220px");
    edge.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(edge.getAttribute("aria-valuenow")).toBe("252");
    expect(localStorage.getItem("ai-office:navigation-width")).toBe("252");
    await userEvent.keyboard("{Home}");
    expect(edge.getAttribute("aria-valuenow")).toBe("160");

    // Dragged: by how far the pointer moves, within its least and most.
    edge.setPointerCapture = vi.fn();
    fireEvent.pointerDown(edge, { clientX: 160, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 260, pointerId: 1 });
    expect(aside?.style.getPropertyValue("--navigation-width")).toBe("260px");
    fireEvent.pointerUp(edge, { clientX: 900, pointerId: 1 });
    expect(edge.getAttribute("aria-valuenow")).toBe("400");
    expect(localStorage.getItem("ai-office:navigation-width")).toBe("400");

    // A double click puts it back; collapsed, there is no edge to drag.
    fireEvent.doubleClick(edge);
    expect(edge.getAttribute("aria-valuenow")).toBe("220");
    expect(localStorage.getItem("ai-office:navigation-width")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse the menu" }),
    );
    expect(
      screen.queryByRole("separator", { name: "Resize the menu" }),
    ).toBeNull();
  });

  it("is reordered with the keyboard or by dragging, kept in this browser", async () => {
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const labels = () =>
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent);
    within(nav).getByRole("link", { name: "Office" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(labels().slice(0, 3)).toEqual(["Overview", "Office", "Notices"]);
    expect(within(nav).getByRole("status").textContent).toBe(
      "Office moved to place 2 of 13.",
    );

    const admin = within(nav).getByRole("link", {
      name: "General Settings",
    });
    const overview = within(nav).getByRole("link", { name: "Overview" });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(admin.closest("li") as HTMLElement, { dataTransfer });
    fireEvent.dragOver(overview.closest("li") as HTMLElement, {
      dataTransfer,
    });
    fireEvent.drop(overview.closest("li") as HTMLElement, { dataTransfer });
    expect(labels().slice(0, 3)).toEqual([
      "General Settings",
      "Overview",
      "Office",
    ]);
    expect(
      JSON.parse(localStorage.getItem("ai-office:navigation-order") ?? "[]"),
    ).toEqual([
      "/general-settings",
      "/overview",
      "/",
      "/notices",
      "/activity",
      "/terminal",
      "/gateway",
      "/analytics",
      "/branches",
      "/agent-settings",
      "/api-keys",
      "/ai-settings",
      "/floor-settings",
    ]);

    // A new visit keeps it, and it can go back to the first order.
    cleanup();
    reloadNavigationPrefs();
    renderAt("/");
    const again = await screen.findByRole("navigation", { name: "Main" });
    expect(within(again).getAllByRole("link")[0]?.textContent).toBe(
      "General Settings",
    );
    await userEvent.click(
      within(again).getByRole("button", { name: "Reset the order" }),
    );
    expect(within(again).getAllByRole("link")[0]?.textContent).toBe("Office");
    expect(localStorage.getItem("ai-office:navigation-order")).toBeNull();
  });

  it.each(pages)(
    "renders the $heading page at $path",
    async ({ path, link, heading }) => {
      renderAt(path);
      expect(
        await screen.findByRole("heading", { level: 1, name: heading }),
      ).toBeDefined();
      const nav = screen.getByRole("navigation", { name: "Main" });
      expect(
        within(nav)
          .getByRole("link", { name: link })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(
        within(nav)
          .getAllByRole("link")
          .filter((element) => element.getAttribute("aria-current") === "page"),
      ).toHaveLength(1);
    },
  );

  it("navigates between pages in the browser", async () => {
    const router = renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "Office - Lobby" });
    const nav = screen.getByRole("navigation", { name: "Main" });

    for (const { path, link, heading } of [...pages].reverse()) {
      await userEvent.click(within(nav).getByRole("link", { name: link }));
      expect(
        await screen.findByRole("heading", { level: 1, name: heading }),
      ).toBeDefined();
      expect(router.state.location.pathname).toBe(path);
    }
  });

  it("shows the company logo, from brand.ts", async () => {
    renderAt("/");
    await screen.findByRole("navigation", { name: "Main" });
    const logos = screen.getAllByTestId("company-logo");
    // One in the narrow-screen header, one in the navigation.
    expect(logos).toHaveLength(2);
    for (const logo of logos) {
      expect(logo.getAttribute("src")).toBe(brand.logo);
      expect(logo.getAttribute("alt")).toBe(brand.name);
    }
    // Each with its dark-mode partner, shown instead when the page is dark.
    const darkLogos = screen.getAllByTestId("company-logo-dark");
    expect(darkLogos).toHaveLength(2);
    for (const logo of darkLogos) {
      expect(logo.getAttribute("src")).toBe(brand.logoDark);
      expect(logo.getAttribute("alt")).toBe(brand.name);
    }
  });

  it("shows a not-found page for an unknown path", async () => {
    renderAt("/no-such-page");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeDefined();
    await waitFor(() => {
      expect(document.title).toBe("AI Office");
    });
  });

  it.each(pages.filter(({ path }) => path !== "/"))(
    'titles the browser tab simply "AI Office" on the $heading page',
    async ({ path }) => {
      renderAt(path);
      await waitFor(() => {
        expect(document.title).toBe("AI Office");
      });
    },
  );

  it('titles the browser tab with where the Office is, "AI Office - Lobby"', async () => {
    renderAt("/");
    await waitFor(() => {
      expect(document.title).toBe("AI Office - Lobby");
    });
  });

  it("names the Floor the lift is at, by the name the Owner gave it, in the heading and the tab", async () => {
    const floor = {
      id: "web-shop",
      name: "Storefront",
      repository: "adrianeyre/web-shop",
      githubRepositoryId: 1,
      template: { id: "development", name: "Development" },
      theme: "office",
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
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url === "/api/session"
            ? Response.json(session)
            : url === "/api/floors"
              ? Response.json({ floors: [floor] })
              : Response.json(healthy),
        ),
      ),
    );
    useLiftStore.getState().call({
      order: 1,
      location: { kind: "floor", floorId: "web-shop" },
    });
    useLiftStore.getState().advance(10, true);
    try {
      renderAt("/");
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: "Office - Storefront",
        }),
      ).toBeDefined();
      await waitFor(() => {
        expect(document.title).toBe("AI Office - Storefront");
      });
    } finally {
      resetLift();
    }
  });

  it.each([
    ["not set up", "setup_required", "/setup"],
    ["signed out", "unauthorized", "/login"],
  ])(
    "shows nothing of the app, not even its navigation, when %s, and goes to %s",
    async (_, error, page) => {
      const load = vi
        .spyOn(browser, "load")
        .mockImplementation(() => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            Response.json(
              { error, message: "No." },
              { status: error === "setup_required" ? 403 : 401 },
            ),
          ),
        ),
      );
      renderAt("/");
      await vi.waitFor(() => {
        expect(load).toHaveBeenCalledWith(page);
      });
      expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
      expect(screen.queryAllByRole("link")).toEqual([]);
    },
  );

  it("leads with a link that skips to the page's main content", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await screen.findByRole("navigation", { name: "Main" });
    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(document.activeElement).toBe(skip);
    await user.click(skip);
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("shows the footer under the page", async () => {
    renderAt("/");
    const footer = await screen.findByRole("contentinfo");
    expect(
      within(footer).getByRole("navigation", { name: "About AI Office" }),
    ).toBeDefined();
  });

  it("opens and closes the navigation on narrow screens", async () => {
    renderAt("/");
    const toggle = await screen.findByRole("button", {
      name: "Open navigation",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(toggle);
    expect(useUiStore.getState().navigationOpen).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Close navigation" })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    // Following a link closes it again.
    await userEvent.click(screen.getByRole("link", { name: "Notices" }));
    await screen.findByRole("heading", { level: 1, name: "Notice Board" });
    expect(useUiStore.getState().navigationOpen).toBe(false);
  });
});

describe("the server status", () => {
  it("reads /health with the shared schema", async () => {
    const fetch = stubHealth(healthy);
    renderAt("/");
    expect(
      (await screen.findByText("Server and database up")).closest(
        "[role=status]",
      ),
    ).not.toBeNull();
    expect(fetch).toHaveBeenCalledWith("/health");
  });

  it("reports a database that is down", async () => {
    stubHealth({ status: "unavailable", database: "down" }, 503);
    renderAt("/");
    expect(await screen.findByText("Database down")).toBeDefined();
  });

  it("reports a server that does not answer as expected", async () => {
    stubHealth({ unexpected: true });
    renderAt("/");
    expect(await screen.findByText("Server unreachable")).toBeDefined();
  });
});
