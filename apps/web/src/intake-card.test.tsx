import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Intake's settings in Admin (PRD FR-8), against a stubbed server.

const defaultIntake = { ownerLogin: "adrianeyre", intervalSeconds: 60 };

function stubServer() {
  const state = { intake: defaultIntake };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/intake" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as typeof defaultIntake;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.intake = body;
        return Promise.resolve(Response.json(state.intake));
      }
      if (url === "/api/office/intake") {
        return Promise.resolve(Response.json(state.intake));
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
  const heading = await screen.findByRole("heading", { name: "Intake" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Intake heading is not in a card.");
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

describe("intake in Admin", () => {
  it("shows the Owner's login and the interval", async () => {
    stubServer();
    const intake = await card();
    expect(
      (await intake.findByLabelText<HTMLInputElement>("Your GitHub login"))
        .value,
    ).toBe("adrianeyre");
    expect(
      intake.getByLabelText<HTMLInputElement>("Check every (seconds)").value,
    ).toBe("60");
  });

  it("saves another login and interval", async () => {
    const { puts } = stubServer();
    const intake = await card();
    const login = await intake.findByLabelText("Your GitHub login");
    await userEvent.clear(login);
    await userEvent.type(login, "ada-lovelace");
    const interval = intake.getByLabelText("Check every (seconds)");
    await userEvent.clear(interval);
    await userEvent.type(interval, "300");
    await userEvent.click(intake.getByRole("button", { name: "Save intake" }));

    expect((await intake.findByRole("status")).textContent).toBe("Saved.");
    expect(puts).toEqual([
      {
        body: { ownerLogin: "ada-lovelace", intervalSeconds: 300 },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("refuses a login GitHub would not allow or too short an interval", async () => {
    const { puts } = stubServer();
    const intake = await card();
    const login = await intake.findByLabelText("Your GitHub login");
    await userEvent.clear(login);
    await userEvent.type(login, "ada_lovelace");
    const interval = intake.getByLabelText("Check every (seconds)");
    await userEvent.clear(interval);
    await userEvent.type(interval, "5");
    await userEvent.click(intake.getByRole("button", { name: "Save intake" }));
    expect(
      within(await intake.findByRole("alert"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "A GitHub login is letters, digits and single hyphens, neither first nor last.",
      "Check at most every 10 seconds.",
    ]);
    expect(puts).toEqual([]);
  });
});
