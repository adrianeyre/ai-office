import { defaultFloorSettings, type Floor } from "@ai-office/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HourlyStatusUpdatesSwitch } from "./hourly-status-setting.tsx";

// A Floor's hourly Status updates (PRD FR-23a), switched on and off on
// their own: saved at once with the CSRF token, saying while it saves and
// when it could not.

const floor: Floor = {
  ...defaultFloorSettings,
  tokenCaps: { daily: null, monthly: null },
  requiredReviewerAgentIds: [],
  id: "web-shop",
  name: "web-shop",
  defaultBranch: "main",
  repository: "adrianeyre/web-shop",
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office",
  createdAt: "2026-10-08T12:00:00.000Z",
  archivedAt: null,
};

let current: Floor = floor;
let refuse = false;
let release: () => void = () => undefined;
let patches: { body: unknown; csrf: string | null }[] = [];

function renderSwitch() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["session"], {
    csrfToken: "csrf-1",
    expiresAt: "2026-10-15T12:00:00.000Z",
  });
  return render(
    <QueryClientProvider client={client}>
      <HourlyStatusUpdatesSwitch floorId="web-shop" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  current = floor;
  refuse = false;
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "PATCH") {
        return url === "/api/floors"
          ? Response.json({ floors: [current] })
          : Response.json(current);
      }
      const body = JSON.parse(init.body as string) as Partial<Floor>;
      patches.push({
        body,
        csrf: new Headers(init.headers).get("x-csrf-token"),
      });
      // Held until the test lets it go, to see it saving.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (refuse) {
        return Response.json(
          { error: "invalid_request", message: "The settings were refused." },
          { status: 400 },
        );
      }
      current = { ...current, ...body };
      return Response.json(current);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the hourly Status updates switch", () => {
  it("shows the Floor's setting, and saves it when switched", async () => {
    renderSwitch();
    const toggle = screen.getByRole<HTMLInputElement>("switch", {
      name: "Hourly Status updates while Agents work",
    });
    await waitFor(() => {
      expect(toggle.checked).toBe(true);
    });
    expect(toggle.disabled).toBe(false);

    await userEvent.click(toggle);
    expect(await screen.findByText("Saving…")).toBeDefined();
    expect(toggle.disabled).toBe(true);
    release();
    await waitFor(() => {
      expect(toggle.checked).toBe(false);
    });
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(patches).toEqual([
      { body: { hourlyStatusUpdates: false }, csrf: "csrf-1" },
    ]);
  });

  it("says when the setting could not be saved, and keeps it as it was", async () => {
    refuse = true;
    renderSwitch();
    const toggle = screen.getByRole<HTMLInputElement>("switch", {
      name: "Hourly Status updates while Agents work",
    });
    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
    });
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    release();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The settings were refused.",
    );
    expect(toggle.checked).toBe(true);
  });
});
