import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The watchdog's time limits in General Settings (PRD FR-23, FR-22),
// against a stubbed server.

const defaultWatchdog = {
  stallTimeoutMinutes: 20,
  sandboxTimeLimitMinutes: 60,
  providers: {},
};

function stubServer() {
  const state: { watchdog: unknown } = { watchdog: defaultWatchdog };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/watchdog" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as unknown;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.watchdog = body;
        return Promise.resolve(Response.json(state.watchdog));
      }
      if (url === "/api/office/watchdog") {
        return Promise.resolve(Response.json(state.watchdog));
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
        createMemoryHistory({ initialEntries: ["/general-settings"] }),
      )}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  const heading = await screen.findByRole("heading", { name: "Watchdog" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Watchdog heading is not in a card.");
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

describe("the watchdog's time limits in General Settings", () => {
  it("shows 20 minutes to stall and an hour per sandbox by default", async () => {
    stubServer();
    const watchdog = await card();
    expect(
      (
        await watchdog.findByLabelText<HTMLInputElement>(
          "Stall timeout (minutes)",
        )
      ).value,
    ).toBe("20");
    expect(
      watchdog.getByLabelText<HTMLInputElement>("Sandbox time limit (minutes)")
        .value,
    ).toBe("60");
  });

  it("saves the office's limits and an AI Provider's own", async () => {
    const { puts } = stubServer();
    const watchdog = await card();
    const stall = await watchdog.findByLabelText("Stall timeout (minutes)");
    await userEvent.clear(stall);
    await userEvent.type(stall, "30");
    await userEvent.click(
      watchdog.getByRole("button", { name: "Add an AI Provider's limits" }),
    );
    await userEvent.selectOptions(
      watchdog.getByLabelText("AI Provider 1"),
      "Ollama",
    );
    await userEvent.type(
      watchdog.getByLabelText("Sandbox time limit 1 (minutes)"),
      "240",
    );
    await userEvent.click(
      watchdog.getByRole("button", { name: "Save watchdog" }),
    );
    expect((await watchdog.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next watchdog check or sandbox start.",
    );
    expect(puts).toEqual([
      {
        body: {
          stallTimeoutMinutes: 30,
          sandboxTimeLimitMinutes: 60,
          providers: { Ollama: { sandboxTimeLimitMinutes: 240 } },
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("refuses a stall timeout under 5 minutes without sending it", async () => {
    const { puts } = stubServer();
    const watchdog = await card();
    const stall = await watchdog.findByLabelText("Stall timeout (minutes)");
    await userEvent.clear(stall);
    await userEvent.type(stall, "4");
    await userEvent.click(
      watchdog.getByRole("button", { name: "Save watchdog" }),
    );
    expect(
      within(await watchdog.findByRole("alert"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["The stall timeout is at least 5 minutes."]);
    expect(puts).toEqual([]);
  });
});
