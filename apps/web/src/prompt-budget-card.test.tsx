import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Prompt budgets in General Settings, against a stubbed server.

const defaults = {
  repositoryMemory: 12_000,
  officeMemory: 12_000,
  roleMemory: 12_000,
  skills: 40_000,
};

function stubServer() {
  const state = { budget: defaults };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/prompt-budget" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as typeof defaults;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.budget = body;
        return Promise.resolve(Response.json(state.budget));
      }
      if (url === "/api/office/prompt-budget") {
        return Promise.resolve(Response.json(state.budget));
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
  const heading = await screen.findByRole("heading", {
    name: "Prompt budgets",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Prompt budgets heading is not in a card.");
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

describe("prompt budgets in General Settings", () => {
  it("shows the defaults", async () => {
    stubServer();
    const view = await card();
    const value = (label: string) =>
      view.getByLabelText<HTMLInputElement>(label).value;
    expect(
      (
        await view.findByLabelText<HTMLInputElement>(
          "Repository memory (characters)",
        )
      ).value,
    ).toBe("12000");
    expect(value("Office-wide memory (characters)")).toBe("12000");
    expect(value("Role memory (characters)")).toBe("12000");
    expect(value("Skills listing (characters)")).toBe("40000");
  });

  it("sets the budgets", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const set = async (label: string, value: string) => {
      const input = view.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    };
    await view.findByLabelText("Repository memory (characters)");
    await set("Role memory (characters)", "4000");
    await set("Skills listing (characters)", "8000");
    await user.click(view.getByRole("button", { name: "Save prompt budgets" }));

    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next task.",
    );
    expect(puts).toEqual([
      {
        body: { ...defaults, roleMemory: 4000, skills: 8000 },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("says what is wrong with a budget it cannot take", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const skills = await view.findByLabelText("Skills listing (characters)");
    await user.clear(skills);
    await user.type(skills, "-1");
    await user.click(view.getByRole("button", { name: "Save prompt budgets" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "The Skills listing's budget is 0 characters or more.",
    );
    expect(puts).toEqual([]);
  });
});
