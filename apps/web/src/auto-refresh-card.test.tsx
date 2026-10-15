import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Auto-refresh in AI Settings (PRD FR-39), against a stubbed server.

function stubServer() {
  const state = { autoRefresh: { enabled: false } };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/auto-refresh" && init?.method === "PUT") {
        const body = JSON.parse(
          init.body as string,
        ) as typeof state.autoRefresh;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.autoRefresh = body;
        return Promise.resolve(Response.json(state.autoRefresh));
      }
      if (url === "/api/office/auto-refresh") {
        return Promise.resolve(Response.json(state.autoRefresh));
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
  return { puts };
}

async function card() {
  render(
    <App
      router={createAppRouter(
        createMemoryHistory({ initialEntries: ["/ai-settings"] }),
      )}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  const heading = await screen.findByRole("heading", { name: "Auto-refresh" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Auto-refresh heading is not in a card.");
  }
  return within(element);
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

describe("auto-refresh in AI Settings", () => {
  it("is off by default, and warns about the AI Providers' terms", async () => {
    stubServer();
    const view = await card();
    expect(
      (
        await view.findByRole<HTMLInputElement>("checkbox", {
          name: /^Start each usage window as soon as it resets/,
        })
      ).checked,
    ).toBe(false);
    expect(
      view.getByRole("note", {
        name: "Auto-refresh and the AI Providers' terms",
      }).textContent,
    ).toContain("allow a subscription only through Claude Code");
  });

  it("turns auto-refresh on", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.click(
      await view.findByRole("checkbox", {
        name: /^Start each usage window as soon as it resets/,
      }),
    );
    await user.click(view.getByRole("button", { name: "Save auto-refresh" }));
    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next minute's check.",
    );
    expect(puts).toEqual([{ body: { enabled: true }, csrf: "csrf-token-1" }]);
  });
});
