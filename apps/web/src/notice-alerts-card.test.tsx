import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import {
  browserNotifications,
  noticeSound,
  useNoticeAlertSettings,
} from "./notice-alerts.ts";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Turning browser notifications on and off in Admin (PRD FR-51). The
// browser asks for permission only when the Owner turns them on.

async function card() {
  render(
    <App
      router={createAppRouter(
        createMemoryHistory({ initialEntries: ["/general-settings"] }),
      )}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  const heading = await screen.findByRole("heading", {
    name: "Browser notifications",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Browser notifications heading is not in a card.");
  }
  return element;
}

const checkbox = (card: HTMLElement, name: string) =>
  within(card).getByRole<HTMLInputElement>("checkbox", { name });

let access: MockInstance<typeof browserNotifications.access>;
let request: MockInstance<typeof browserNotifications.request>;
let unlock: MockInstance<typeof noticeSound.unlock>;

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url === "/api/session"
          ? Response.json({
              csrfToken: "csrf-token",
              expiresAt: "2026-10-15T12:00:00.000Z",
            })
          : Response.json({}, { status: 404 }),
      ),
    ),
  );
  access = vi.spyOn(browserNotifications, "access").mockReturnValue("default");
  request = vi
    .spyOn(browserNotifications, "request")
    .mockResolvedValue("granted");
  unlock = vi.spyOn(noticeSound, "unlock").mockImplementation(() => undefined);
  useNoticeAlertSettings.setState({ notify: false, sound: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("browser notifications in Admin", () => {
  it("starts off, and never asks the browser on load", async () => {
    const alerts = await card();
    expect(checkbox(alerts, "Notify me of action Notices").checked).toBe(false);
    expect(checkbox(alerts, "Play a sound").disabled).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("asks for permission when turned on, and keeps it on this browser", async () => {
    const alerts = await card();
    await userEvent.click(checkbox(alerts, "Notify me of action Notices"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalled();
    expect(checkbox(alerts, "Notify me of action Notices").checked).toBe(true);
    expect(checkbox(alerts, "Play a sound").checked).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("ai-office:notice-alerts") ?? "{}"),
    ).toMatchObject({ state: { notify: true, sound: true } });
  });

  it("mutes the sound, and turns notifications off", async () => {
    access.mockReturnValue("granted");
    useNoticeAlertSettings.setState({ notify: true, sound: true });
    const alerts = await card();
    await userEvent.click(checkbox(alerts, "Play a sound"));
    expect(useNoticeAlertSettings.getState().sound).toBe(false);
    await userEvent.click(checkbox(alerts, "Notify me of action Notices"));
    expect(useNoticeAlertSettings.getState().notify).toBe(false);
    // Already allowed, so the browser was never asked again.
    expect(request).not.toHaveBeenCalled();
  });

  it("stays off, saying why, when the browser refuses", async () => {
    request.mockResolvedValue("denied");
    const alerts = await card();
    await userEvent.click(checkbox(alerts, "Notify me of action Notices"));
    expect((await within(alerts).findByRole("alert")).textContent).toBe(
      "This browser blocks notifications from AI Office. Allow them in its settings for this site, then turn this on again.",
    );
    expect(checkbox(alerts, "Notify me of action Notices").checked).toBe(false);
    expect(useNoticeAlertSettings.getState().notify).toBe(false);
  });
});
