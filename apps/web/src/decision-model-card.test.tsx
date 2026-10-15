import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The Decision Model in AI Settings (PRD FR-17, FR-89), against a stubbed
// server.

function stubServer() {
  const state = {
    decisionModel: {
      enabled: false,
      model: "typesafe/jev-1.13",
      summaries: false,
    },
  };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const path = "/api/office/decision-model";
      if (url === path && init?.method === "PUT") {
        const body = JSON.parse(
          init.body as string,
        ) as typeof state.decisionModel;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.decisionModel = body;
        return Promise.resolve(Response.json(state.decisionModel));
      }
      if (url === path) {
        return Promise.resolve(Response.json(state.decisionModel));
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
    name: "Decision Model",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Decision Model heading is not in a card.");
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

describe("the Decision Model in AI Settings", () => {
  it("is off by default, as Jev 1.13, writing no summaries", async () => {
    stubServer();
    const view = await card();
    expect(
      (
        await view.findByRole<HTMLInputElement>("checkbox", {
          name: /^Use Jev as the Decision Model/,
        })
      ).checked,
    ).toBe(false);
    expect(
      view.getByRole<HTMLInputElement>("textbox", { name: "Jev's Model" })
        .value,
    ).toBe("typesafe/jev-1.13");
    expect(
      view.getByRole<HTMLInputElement>("checkbox", {
        name: /^Have it write summaries/,
      }).checked,
    ).toBe(false);
  });

  it("turns Jev on, with its newest Model, writing summaries", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.click(
      await view.findByRole("checkbox", {
        name: /^Use Jev as the Decision Model/,
      }),
    );
    const model = view.getByRole("textbox", { name: "Jev's Model" });
    await user.clear(model);
    await user.type(model, "~typesafe/jev-latest");
    await user.click(
      view.getByRole("checkbox", { name: /^Have it write summaries/ }),
    );
    await user.click(view.getByRole("button", { name: "Save Decision Model" }));
    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies at once.",
    );
    expect(puts).toEqual([
      {
        body: {
          enabled: true,
          model: "~typesafe/jev-latest",
          summaries: true,
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("takes nothing but Jev, and saves nothing else", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const model = await view.findByRole("textbox", { name: "Jev's Model" });
    await user.clear(model);
    await user.type(model, "claude-opus-5-5");
    await user.click(view.getByRole("button", { name: "Save Decision Model" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      "The Decision Model is Jev: name it as OpenRouter does",
    );
    expect(puts).toEqual([]);
  });
});
