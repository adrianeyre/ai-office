import type { StatusUpdate } from "@ai-office/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { useSceneSettings } from "./scene/scene-settings.ts";
import {
  forgetDailyStatusUpdates,
  StatusUpdateButton,
  StatusUpdatePanel,
  useDailyStatusUpdate,
  useGivenStatusUpdates,
  useStatusUpdateStore,
} from "./status-update.tsx";

// A Floor's Status update in the Office (PRD FR-23a): the button gives one
// now, opening the Floor asks for the day's once, one given by itself (the
// hourly one) is read from its event, and the panel shows each Agent's
// part, the Manager first, each marked in turn as it speaks.

const given: StatusUpdate = {
  floorId: "web-shop",
  eventId: 12,
  trigger: "owner",
  day: "2026-10-12",
  reportedDay: "2026-10-09",
  givenAt: "2026-10-12T08:30:00.000Z",
  entries: [
    {
      agentId: "grace",
      name: "Grace",
      role: "manager",
      did: ["Triaged 1 issue."],
      today: ["Triage whatever comes in, and tell you what needs you."],
    },
    {
      agentId: "adrian",
      name: "Adrian",
      role: "Coder",
      did: [],
      today: ["Carry on with #13, at needs-work."],
    },
  ],
};

const hourly: StatusUpdate = {
  ...given,
  eventId: 20,
  trigger: "hourly",
  reportedDay: "2026-10-12",
  givenAt: "2026-10-12T10:00:00.000Z",
};

let posts: { url: string; csrf: string | null }[] = [];
let answer: StatusUpdate | null = given;
let latest: StatusUpdate | null = null;

function Daily({ floorId }: { floorId: string }) {
  useDailyStatusUpdate(floorId);
  return <StatusUpdatePanel floorId={floorId} />;
}

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["session"], {
    csrfToken: "csrf-1",
    expiresAt: "2026-10-15T12:00:00.000Z",
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  posts = [];
  answer = given;
  latest = null;
  forgetDailyStatusUpdates();
  useStatusUpdateStore.getState().close();
  useSceneSettings.setState({ reducedMotion: false });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      posts.push({ url, csrf: headers.get("x-csrf-token") });
      if (url.endsWith("/latest")) {
        return Promise.resolve(Response.json({ statusUpdate: latest }));
      }
      return Promise.resolve(
        Response.json(
          {
            statusUpdate:
              answer === null
                ? null
                : {
                    ...answer,
                    trigger: url.endsWith("/daily") ? "daily" : "owner",
                  },
          },
          { status: answer === null ? 200 : 201 },
        ),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Status update", () => {
  it("is given with the button, with the CSRF token, and shown each Agent's part in turn", async () => {
    renderWith(
      <>
        <StatusUpdatePanel floorId="web-shop" />
        <StatusUpdateButton floorId="web-shop" />
      </>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Status update" }),
    );
    const panel = await screen.findByRole("region", { name: "Status update" });
    expect(posts).toEqual([
      { url: "/api/floors/web-shop/status-update", csrf: "csrf-1" },
    ]);
    expect(panel.textContent).toContain(
      "What each did on Friday 9 October, and plans today.",
    );
    // Beside the panel frame's own, for moving and resizing it.
    expect(
      screen.getAllByRole("status").map(({ textContent }) => textContent),
    ).toContain(
      "Status update: 2 Agents report on Friday 9 October and today.",
    );
    const parts = within(
      screen.getByRole("list", { name: "What each Agent says" }),
    ).getAllByRole("listitem");
    expect(parts[0]?.textContent).toContain("Grace (manager)");
    expect(parts[0]?.textContent).toContain("Triaged 1 issue.");
    // The Manager speaks first.
    expect(
      screen.getByText("Grace").closest("li")?.getAttribute("aria-current"),
    ).toBe("true");
    expect(panel.textContent).toContain("Nothing to report.");

    await userEvent.click(
      screen.getByRole("button", { name: "Close the Status update" }),
    );
    expect(screen.queryByRole("region", { name: "Status update" })).toBeNull();
  });

  it("moves, resizes and fills the screen like the Office's other panels, within the view", async () => {
    // A view wide enough to move a panel in (jsdom lays nothing out).
    const sized = (size: number) =>
      function (this: HTMLElement) {
        return this.hasAttribute("data-panel-area") ? size : 0;
      };
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      sized(1200),
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      sized(800),
    );
    useStatusUpdateStore.getState().show(given);
    renderWith(
      <div data-panel-area="">
        <StatusUpdatePanel floorId="web-shop" />
      </div>,
    );
    expect(screen.getByRole("button", { name: "Move panel" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(
      screen.getByRole("region", { name: "Status update" }).dataset["layout"],
    ).toBe("full");
    await userEvent.click(
      screen.getByRole("button", { name: "Restore panel" }),
    );
    expect(
      screen.getByRole("region", { name: "Status update" }).dataset["layout"],
    ).not.toBe("full");
  });

  it("marks each Agent's turn, then no one's once all have spoken", () => {
    vi.useFakeTimers();
    useStatusUpdateStore.getState().show(given);
    renderWith(<StatusUpdatePanel floorId="web-shop" />);
    const speaking = () =>
      screen
        .getAllByRole("listitem")
        .filter((item) => item.getAttribute("aria-current") === "true")
        .map((item) => item.querySelector("p")?.textContent);
    expect(speaking()).toEqual(["Grace (manager), speaking"]);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(speaking()).toEqual(["Adrian (Coder), speaking"]);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(speaking()).toEqual([]);
  });

  it("with reduced motion marks no one: the whole update reads at once", () => {
    useSceneSettings.setState({ reducedMotion: true });
    useStatusUpdateStore.getState().show(given);
    renderWith(<StatusUpdatePanel floorId="web-shop" />);
    expect(
      screen
        .getAllByRole("listitem")
        .some((item) => item.getAttribute("aria-current") === "true"),
    ).toBe(false);
  });

  it("is asked for once when a Floor is opened, and shown only when the server gives it", async () => {
    const { unmount } = renderWith(<Daily floorId="web-shop" />);
    expect(
      await screen.findByRole("region", { name: "Status update" }),
    ).toBeDefined();
    expect(posts).toEqual([
      { url: "/api/floors/web-shop/status-update/daily", csrf: "csrf-1" },
    ]);
    // Opened again in the same page: not asked again.
    unmount();
    useStatusUpdateStore.getState().close();
    renderWith(<Daily floorId="web-shop" />);
    expect(posts).toHaveLength(1);

    // Another Floor, whose day's update was given already: nothing shown.
    answer = null;
    renderWith(<Daily floorId="docs" />);
    await waitFor(() => {
      expect(posts).toHaveLength(2);
    });
    expect(screen.queryByRole("region", { name: "Status update" })).toBeNull();
  });

  it("given by itself, as the hourly one is, is read from its event and shown, saying the last hour", async () => {
    const sources: { url: string; source: EventSourceLike }[] = [];
    vi.spyOn(eventSources, "open").mockImplementation((url) => {
      const source: EventSourceLike = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        close: () => undefined,
      };
      sources.push({ url, source });
      return source;
    });
    function Given() {
      useGivenStatusUpdates("web-shop");
      return <StatusUpdatePanel floorId="web-shop" />;
    }
    renderWith(<Given />);
    const told = (id: number) => {
      act(() => {
        sources[0]?.source.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify({
              id,
              occurredAt: "2026-10-12T10:00:00.000Z",
              event: {
                type: "status_update.given",
                version: 1,
                floorId: "web-shop",
                agentId: "grace",
                agentIds: ["adrian"],
                day: "2026-10-12",
                reportedDay: "2026-10-12",
                trigger: "hourly",
                messageId: 3,
              },
            }),
          }),
        );
      });
    };
    expect(sources[0]?.url).toContain("status_update.given");

    // The latest given is another, newer one: not shown.
    latest = { ...hourly, eventId: 21 };
    told(20);
    await waitFor(() => {
      expect(posts.map(({ url }) => url)).toEqual([
        "/api/floors/web-shop/status-update/latest",
      ]);
    });
    expect(screen.queryByRole("region", { name: "Status update" })).toBeNull();

    latest = hourly;
    told(20);
    const panel = await screen.findByRole("region", { name: "Status update" });
    expect(panel.textContent).toContain(
      "Given each hour while this Floor's Agents work. What each did in the last hour, and plans today.",
    );
    expect(panel.textContent).toContain("In the last hour");
    expect(
      screen.getAllByRole("status").map(({ textContent }) => textContent),
    ).toContain("Status update: 2 Agents report in the last hour and today.");

    // Told again, as when the stream resumes: already shown, not read again.
    told(20);
    expect(posts).toHaveLength(2);
  });

  it("is shown only on its own Floor", () => {
    useStatusUpdateStore.getState().show(given);
    renderWith(<StatusUpdatePanel floorId="docs" />);
    expect(screen.queryByRole("region", { name: "Status update" })).toBeNull();
  });
});
