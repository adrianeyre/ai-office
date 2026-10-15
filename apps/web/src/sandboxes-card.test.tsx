import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The office-wide sandbox limit in Admin (PRD FR-22), against a stubbed
// server.

const defaultSandboxes = { concurrencyLimit: 3 };

function stubServer() {
  const state = { sandboxes: defaultSandboxes };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/sandboxes" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as typeof defaultSandboxes;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.sandboxes = body;
        return Promise.resolve(Response.json(state.sandboxes));
      }
      if (url === "/api/office/sandboxes") {
        return Promise.resolve(Response.json(state.sandboxes));
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
  const heading = await screen.findByRole("heading", { name: "Sandboxes" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Sandboxes heading is not in a card.");
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

describe("the sandbox limit in Admin", () => {
  it("shows the limit, 3 by default", async () => {
    stubServer();
    const sandboxes = await card();
    expect(
      (await sandboxes.findByLabelText<HTMLInputElement>("Sandboxes at once"))
        .value,
    ).toBe("3");
  });

  it("saves another limit", async () => {
    const { puts } = stubServer();
    const sandboxes = await card();
    const limit = await sandboxes.findByLabelText("Sandboxes at once");
    await userEvent.clear(limit);
    await userEvent.type(limit, "1");
    await userEvent.click(
      sandboxes.getByRole("button", { name: "Save sandbox limit" }),
    );
    expect((await sandboxes.findByRole("status")).textContent).toBe("Saved.");
    expect(puts).toEqual([
      { body: { concurrencyLimit: 1 }, csrf: "csrf-token-1" },
    ]);
  });

  it("refuses a limit below 1 without sending it", async () => {
    const { puts } = stubServer();
    const sandboxes = await card();
    const limit = await sandboxes.findByLabelText("Sandboxes at once");
    await userEvent.clear(limit);
    await userEvent.type(limit, "0");
    await userEvent.click(
      sandboxes.getByRole("button", { name: "Save sandbox limit" }),
    );
    expect(
      within(await sandboxes.findByRole("alert"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Allow at least 1 sandbox at once."]);
    expect(puts).toEqual([]);
  });
});
