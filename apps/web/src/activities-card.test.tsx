import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { placeOf } from "./activities-card.tsx";
import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { idleActivities } from "./scene/idle-behaviours.ts";
import { location } from "./totp-settings.tsx";

// Agent activities in Agent Settings, against a stubbed server: every idle
// activity listed, and a Floor's turned off and on.

const webShop = {
  id: "web-shop",
  name: "Web shop",
  repository: "adrianeyre/web-shop",
  githubRepositoryId: 1,
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
  template: { id: "development", name: "Development" },
  theme: "office",
  createdAt: "2026-10-08T12:00:00.000Z",
  archivedAt: null,
};

function stubServer() {
  let disabled: Record<string, string[]> = {};
  const puts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as { disabled: string[] };
        puts.push({ url, body });
        disabled = { "web-shop": body.disabled };
        return Promise.resolve(Response.json({ disabled }));
      }
      switch (url) {
        case "/api/session":
          return Promise.resolve(
            Response.json({
              csrfToken: "csrf-token-1",
              expiresAt: "2026-10-15T12:00:00.000Z",
            }),
          );
        case "/api/floors":
          return Promise.resolve(Response.json({ floors: [webShop] }));
        case "/api/office/activities":
          return Promise.resolve(Response.json({ disabled }));
        default:
          return Promise.resolve(Response.json({}, { status: 404 }));
      }
    }),
  );
  return { puts };
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Agent activities in Agent Settings", () => {
  it("lists every activity, where it happens", async () => {
    stubServer();
    render(
      <App
        router={createAppRouter(
          createMemoryHistory({
            initialEntries: ["/agent-settings?floor=web-shop"],
          }),
        )}
        queryClient={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      />,
    );
    const table = within(
      await screen.findByRole("table", { name: "Agent activities" }),
    );
    expect(table.getAllByRole("row")).toHaveLength(idleActivities.length + 1);
    expect(
      table.getByRole("rowheader", { name: "Water-cooler chat" }),
    ).toBeDefined();
    expect(placeOf({ location: "water-cooler" })).toBe("At the water cooler");
    expect(placeOf({ location: "chair" })).toBe("In their chair");
  });

  it("turns activities off for a Floor, and saves them", async () => {
    const { puts } = stubServer();
    render(
      <App
        router={createAppRouter(
          createMemoryHistory({
            initialEntries: ["/agent-settings?floor=web-shop"],
          }),
        )}
        queryClient={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      />,
    );
    const darts = await screen.findByRole("checkbox", {
      name: "Darts on Web shop",
    });
    expect((darts as HTMLInputElement).checked).toBe(true);
    await userEvent.click(darts);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Water-cooler chat on Web shop" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save Web shop's activities" }),
    );
    const card = within(
      screen
        .getByRole("heading", { name: "Agent activities" })
        .closest<HTMLElement>("[data-slot=card]") ?? document.body,
    );
    expect((await card.findByRole("status")).textContent).toBe(
      `Saved. Web shop's Agents do ${String(idleActivities.length - 2)} of the ${String(idleActivities.length)} activities.`,
    );
    expect(puts).toEqual([
      {
        url: "/api/floors/web-shop/activities",
        body: { disabled: ["darts", "water-cooler chat"] },
      },
    ]);
  });
});
