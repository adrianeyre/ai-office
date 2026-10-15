import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Retries in AI Settings (PRD FR-39), against a stubbed server.

const defaults = {
  attempts: 3,
  delayMs: 500,
  multiplier: 2,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownSeconds: 60,
};

function stubServer() {
  const state = { retries: defaults };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/retries" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as typeof defaults;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.retries = body;
        return Promise.resolve(Response.json(state.retries));
      }
      if (url === "/api/office/retries") {
        return Promise.resolve(Response.json(state.retries));
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
  const heading = await screen.findByRole("heading", { name: "Retries" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Retries heading is not in a card.");
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

describe("retries in AI Settings", () => {
  it("shows the defaults", async () => {
    stubServer();
    const view = await card();
    const value = (label: string) =>
      view.getByLabelText<HTMLInputElement>(label).value;
    expect(
      (await view.findByLabelText<HTMLInputElement>("Attempts")).value,
    ).toBe("3");
    expect(value("First wait (milliseconds)")).toBe("500");
    expect(value("Multiplier")).toBe("2");
    expect(value("Failures before the circuit opens")).toBe("5");
    expect(value("Rest (seconds)")).toBe("60");
  });

  it("sets the attempts, delay and multiplier", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const set = async (label: string, value: string) => {
      const input = view.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    };
    await view.findByLabelText("Attempts");
    await set("Attempts", "5");
    await set("First wait (milliseconds)", "250");
    await set("Multiplier", "1.5");
    await user.click(view.getByRole("button", { name: "Save retries" }));

    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next request.",
    );
    expect(puts).toEqual([
      {
        body: { ...defaults, attempts: 5, delayMs: 250, multiplier: 1.5 },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("says what is wrong with settings it cannot take", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const attempts = await view.findByLabelText("Attempts");
    await user.clear(attempts);
    await user.type(attempts, "0");
    await user.click(view.getByRole("button", { name: "Save retries" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "Make at least 1 attempt.",
    );
    expect(puts).toEqual([]);
  });
});
