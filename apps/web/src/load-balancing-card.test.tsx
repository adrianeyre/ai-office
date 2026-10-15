import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Load balancing in AI Settings (PRD FR-37), against a stubbed server.

const defaults = { strategy: "session", sessionWindowMinutes: 300 };

function stubServer() {
  const state = { balancing: defaults };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/load-balancing" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as typeof defaults;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.balancing = body;
        return Promise.resolve(Response.json(state.balancing));
      }
      if (url === "/api/office/load-balancing") {
        return Promise.resolve(Response.json(state.balancing));
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
    name: "Load balancing",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Load balancing heading is not in a card.");
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

describe("load balancing in AI Settings", () => {
  it("balances by session for five hours by default", async () => {
    stubServer();
    const view = await card();
    expect(
      (
        await view.findByRole<HTMLInputElement>("radio", {
          name: /^Session(?! affinity)/,
        })
      ).checked,
    ).toBe(true);
    expect(
      view.getByRole<HTMLInputElement>("radio", { name: /^Least used/ })
        .checked,
    ).toBe(false);
    expect(
      view.getByLabelText<HTMLInputElement>("Session window (minutes)").value,
    ).toBe("300");
  });

  it("switches to least-used and changes the window, saving at once", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.click(await view.findByRole("radio", { name: /^Least used/ }));
    const window = view.getByLabelText("Session window (minutes)");
    await user.clear(window);
    await user.type(window, "90");
    await user.click(view.getByRole("button", { name: "Save load balancing" }));

    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next request.",
    );
    expect(puts).toEqual([
      {
        body: { strategy: "least_used", sessionWindowMinutes: 90 },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("offers every strategy, and saves session affinity or drain soonest (strict)", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByRole("radio", { name: /^Least used/ });
    expect(
      view.getAllByRole<HTMLInputElement>("radio").map(({ value }) => value),
    ).toEqual([
      "session",
      "session_affinity",
      "drain_soonest",
      "drain_soonest_strict",
      "least_used",
    ]);
    await user.click(
      view.getByRole("radio", { name: /^Drain soonest \(strict\)/ }),
    );
    await user.click(view.getByRole("button", { name: "Save load balancing" }));
    await view.findByRole("status");
    await user.click(view.getByRole("radio", { name: /^Session affinity/ }));
    await user.click(view.getByRole("button", { name: "Save load balancing" }));
    await vi.waitFor(() => {
      expect(puts.map(({ body }) => body)).toEqual([
        { strategy: "drain_soonest_strict", sessionWindowMinutes: 300 },
        { strategy: "session_affinity", sessionWindowMinutes: 300 },
      ]);
    });
  });

  it("says what is wrong with a window it cannot take", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const window = await view.findByLabelText("Session window (minutes)");
    await user.clear(window);
    await user.type(window, "0");
    await user.click(view.getByRole("button", { name: "Save load balancing" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "The session window is at least 1 minute.",
    );
    expect(puts).toEqual([]);
  });
});
