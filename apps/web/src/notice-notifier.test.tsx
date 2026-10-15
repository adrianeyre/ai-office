import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import {
  browserNotifications,
  noticeSound,
  useNoticeAlertSettings,
  type ShownNotification,
} from "./notice-alerts.ts";
import { createAppRouter } from "./router.tsx";

// Browser notifications for action Notices (PRD FR-51), on any page: the
// event stream, the browser's notifications and the sound are stand-ins
// the test drives and watches.

interface FakeStream extends Omit<EventSourceLike, "readyState"> {
  readyState: number;
  readonly url: string;
  send(data: unknown): void;
}

let streams: FakeStream[];
let shown: {
  title: string;
  options: NotificationOptions;
  n: ShownNotification;
  /** Its `close`, watched. */
  closed: () => void;
}[];

let access: MockInstance<typeof browserNotifications.access>;
let play: MockInstance<typeof noticeSound.play>;

const noticeStream = (): FakeStream | undefined =>
  streams.find(({ url }) => url === "/api/events/stream?type=notice.raised");

const raise = (kind: "action" | "info", id = "notice-1") => {
  act(() => {
    noticeStream()?.send({
      id: Number(id.replace("notice-", "")),
      occurredAt: "2026-10-08T12:00:00.000Z",
      event: {
        type: "notice.raised",
        version: 1,
        noticeId: id,
        kind,
        title:
          kind === "action" ? "PR #14 awaiting your approval" : "PR #3 opened",
        floorId: "web-shop",
      },
    });
  });
};

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

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url === "/api/session"
          ? Response.json({
              csrfToken: "csrf-token-1",
              expiresAt: "2026-10-15T12:00:00.000Z",
            })
          : url.startsWith("/api/notices")
            ? Response.json({ notices: [] })
            : Response.json({}, { status: 404 }),
      ),
    ),
  );
  streams = [];
  vi.spyOn(eventSources, "open").mockImplementation((url) => {
    const source: FakeStream = {
      url,
      readyState: 1,
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
  shown = [];
  access = vi.spyOn(browserNotifications, "access").mockReturnValue("granted");
  vi.spyOn(browserNotifications, "show").mockImplementation(
    (title, options) => {
      const closed = vi.fn();
      const n: ShownNotification = { onclick: null, close: closed };
      shown.push({ title, options, n, closed });
      return n;
    },
  );
  play = vi.spyOn(noticeSound, "play").mockImplementation(() => undefined);
  vi.spyOn(noticeSound, "unlock").mockImplementation(() => undefined);
  useNoticeAlertSettings.setState({ notify: true, sound: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("notifications of action Notices", () => {
  it("shows one, with the sound, for a new action Notice", async () => {
    renderAt("/activity");
    await screen.findByRole("heading", { level: 1, name: "Activity" });
    raise("action");
    expect(shown.map(({ title, options }) => [title, options])).toEqual([
      [
        "PR #14 awaiting your approval",
        {
          body: "Needs your action on web-shop.",
          tag: "notice-1",
          silent: true,
        },
      ],
    ]);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stays silent for an info Notice", async () => {
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "Office - Lobby" });
    raise("info");
    expect(shown).toEqual([]);
    expect(play).not.toHaveBeenCalled();
  });

  it("plays no sound when the sound is muted", async () => {
    useNoticeAlertSettings.setState({ notify: true, sound: false });
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "Office - Lobby" });
    raise("action");
    expect(shown).toHaveLength(1);
    expect(play).not.toHaveBeenCalled();
  });

  it("does nothing, and opens no stream for it, while notifications are off", async () => {
    useNoticeAlertSettings.setState({ notify: false, sound: true });
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "Office - Lobby" });
    expect(noticeStream()).toBeUndefined();
    expect(shown).toEqual([]);
  });

  it("does nothing when the browser no longer allows notifications", async () => {
    access.mockReturnValue("denied");
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "Office - Lobby" });
    raise("action");
    expect(shown).toEqual([]);
    expect(play).not.toHaveBeenCalled();
  });

  it("opens that Notice on the Notice Board when clicked", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    const router = renderAt("/general-settings");
    await screen.findByRole("heading", { level: 1, name: "General Settings" });
    raise("action", "notice-7");
    const [notification] = shown;
    act(() => {
      notification?.n.onclick?.(new Event("click"));
    });
    await screen.findByRole("heading", { level: 1, name: "Notice Board" });
    expect(router.state.location.pathname).toBe("/notices");
    expect(router.state.location.search).toEqual({ notice: "notice-7" });
    expect(focus).toHaveBeenCalled();
    expect(notification?.closed).toHaveBeenCalled();
  });
});
