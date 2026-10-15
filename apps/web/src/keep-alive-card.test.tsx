import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Prompt-cache keep-alive in AI Settings (PRD FR-39), against a stubbed
// server.

function stubServer() {
  const state = {
    keepAlive: { enabled: false, idleMinutes: 30, maxPerAccountPerHour: 60 },
  };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const path = "/api/office/prompt-cache-keep-alive";
      if (url === path && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as typeof state.keepAlive;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.keepAlive = body;
        return Promise.resolve(Response.json(state.keepAlive));
      }
      if (url === path) {
        return Promise.resolve(Response.json(state.keepAlive));
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
  const heading = await screen.findByRole("heading", {
    name: "Prompt-cache keep-alive",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The keep-alive heading is not in a card.");
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

describe("prompt-cache keep-alive in AI Settings", () => {
  it("is off by default, with its bounds, and warns about the AI Providers' terms", async () => {
    stubServer();
    const view = await card();
    expect(
      (
        await view.findByRole<HTMLInputElement>("checkbox", {
          name: /^Keep Agents' prompt caches warm/,
        })
      ).checked,
    ).toBe(false);
    expect(
      view.getByRole<HTMLInputElement>("spinbutton", {
        name: "Idle time (minutes)",
      }).value,
    ).toBe("30");
    expect(
      view.getByRole<HTMLInputElement>("spinbutton", {
        name: "Keep-alives per AI Account an hour",
      }).value,
    ).toBe("60");
    expect(
      view.getByRole("note", {
        name: "Keep-alive and the AI Providers' terms",
      }).textContent,
    ).toContain("allow a subscription only through Claude Code");
  });

  it("turns keep-alive on, with its idle time and bound", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.click(
      await view.findByRole("checkbox", {
        name: /^Keep Agents' prompt caches warm/,
      }),
    );
    const idle = view.getByRole("spinbutton", { name: "Idle time (minutes)" });
    await user.clear(idle);
    await user.type(idle, "45");
    const bound = view.getByRole("spinbutton", {
      name: "Keep-alives per AI Account an hour",
    });
    await user.clear(bound);
    await user.type(bound, "20");
    await user.click(view.getByRole("button", { name: "Save keep-alive" }));
    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next round, within 15 seconds.",
    );
    expect(puts).toEqual([
      {
        body: { enabled: true, idleMinutes: 45, maxPerAccountPerHour: 20 },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("says what is wrong, and saves nothing, outside the bounds", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const idle = await view.findByRole("spinbutton", {
      name: "Idle time (minutes)",
    });
    await user.clear(idle);
    await user.type(idle, "2");
    await user.click(view.getByRole("button", { name: "Save keep-alive" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      "Keep sessions warm for at least 5 minutes.",
    );
    expect(puts).toEqual([]);
  });
});
