import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Usage throttling's pacing gates in AI Settings (PRD FR-38), against a stubbed
// server.

function stubServer() {
  const state = { throttling: { fiveHourPacing: false, weeklyPacing: false } };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/usage-throttling" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as typeof state.throttling;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.throttling = body;
        return Promise.resolve(Response.json(state.throttling));
      }
      if (url === "/api/office/usage-throttling") {
        return Promise.resolve(Response.json(state.throttling));
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
    name: "Usage throttling",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Usage throttling heading is not in a card.");
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

describe("usage throttling in AI Settings", () => {
  it("paces no window by default", async () => {
    stubServer();
    const view = await card();
    expect(
      (
        await view.findByRole<HTMLInputElement>("checkbox", {
          name: /^Pace each five-hour window/,
        })
      ).checked,
    ).toBe(false);
    expect(
      view.getByRole<HTMLInputElement>("checkbox", {
        name: /^Pace each weekly window/,
      }).checked,
    ).toBe(false);
  });

  it("turns the five-hour gate on, saving at once", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.click(
      await view.findByRole("checkbox", {
        name: /^Pace each five-hour window/,
      }),
    );
    await user.click(
      view.getByRole("button", { name: "Save usage throttling" }),
    );
    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next request.",
    );
    expect(puts).toEqual([
      {
        body: { fiveHourPacing: true, weeklyPacing: false },
        csrf: "csrf-token-1",
      },
    ]);
  });
});
