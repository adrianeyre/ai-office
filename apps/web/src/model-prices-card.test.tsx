import type { ModelPriceEntry } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Model prices in AI Settings (PRD FR-43), against a stubbed server that behaves
// as the API does: the Owner's price wins until it is removed.

const opus = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };

function stubServer() {
  const overrides = new Map<string, ModelPriceEntry["price"]>();
  const sent: { method: string; url: string; body: unknown }[] = [];
  const list = (): ModelPriceEntry[] => {
    const models = new Set(["claude-opus-5-5", ...overrides.keys()]);
    return [...models].sort().map((model) => {
      const standard = model === "claude-opus-5-5" ? opus : null;
      const override = overrides.get(model);
      return override === undefined
        ? { model, price: opus, source: "table", standard, updatedAt: null }
        : {
            model,
            price: override,
            source: "override",
            standard,
            updatedAt: "2026-10-09T12:00:00.000Z",
          };
    });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/gateway/prices/")) {
        const model = decodeURIComponent(url.split("/")[4] ?? "");
        const body: unknown =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        sent.push({ method, url, body });
        if (method === "PUT") {
          overrides.set(model, body as ModelPriceEntry["price"]);
          return Promise.resolve(
            Response.json(list().find((entry) => entry.model === model)),
          );
        }
        overrides.delete(model);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/gateway/prices") {
        return Promise.resolve(Response.json({ prices: list() }));
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
  return { sent };
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
  const heading = await screen.findByRole("heading", { name: "Model prices" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Model prices heading is not in a card.");
  }
  return within(element);
}

const cells = (row: HTMLElement) =>
  [...row.querySelectorAll("th, td")].map((cell) => cell.textContent);

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Model prices in AI Settings", () => {
  it("lists each Model's prices per million tokens and where they come from", async () => {
    stubServer();
    const view = await card();
    const row = await view.findByRole("row", { name: "claude-opus-5-5" });
    expect(cells(row).slice(0, 6)).toEqual([
      "claude-opus-5-5",
      "$4",
      "$20",
      "$5",
      "$0.2",
      "Pricing table",
    ]);
  });

  it("overrides a price, then goes back to the default", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.click(
      await view.findByRole("button", { name: "Edit claude-opus-5-5's price" }),
    );
    const form = view.getByRole("form", { name: "Price claude-opus-5-5" });
    const input = within(form).getByLabelText("Input");
    await user.clear(input);
    await user.type(input, "3.5");
    await user.click(within(form).getByRole("button", { name: "Save price" }));

    const row = await view.findByRole("row", { name: "claude-opus-5-5" });
    await vi.waitFor(() => {
      expect(cells(row).slice(1, 6)).toEqual([
        "$3.5",
        "$20",
        "$5",
        "$0.2",
        "Yours",
      ]);
    });
    expect(sent[0]).toEqual({
      method: "PUT",
      url: "/api/gateway/prices/claude-opus-5-5",
      body: { ...opus, input: 3.5 },
    });

    await user.click(
      view.getByRole("button", {
        name: "Use the default price for claude-opus-5-5",
      }),
    );
    await vi.waitFor(() => {
      expect(cells(row)[5]).toBe("Pricing table");
    });
    expect(sent[1]).toMatchObject({ method: "DELETE" });
  });

  it("prices a Model that is in no table, and checks the amounts first", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const form = await view.findByRole("form", { name: "Price a Model" });
    await user.type(within(form).getByLabelText("Model"), "openai/gpt-5.5");
    await user.type(within(form).getByLabelText("Input"), "1.25");
    await user.click(within(form).getByRole("button", { name: "Save price" }));
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "Each price is a number of dollars.",
    );
    expect(sent).toEqual([]);

    await user.type(within(form).getByLabelText("Output"), "10");
    await user.type(within(form).getByLabelText("Cache write"), "1.25");
    await user.type(within(form).getByLabelText("Cache read"), "0.125");
    await user.click(within(form).getByRole("button", { name: "Save price" }));
    const row = await view.findByRole("row", { name: "openai/gpt-5.5" });
    expect(cells(row).slice(1, 6)).toEqual([
      "$1.25",
      "$10",
      "$1.25",
      "$0.125",
      "Yours",
    ]);
    expect(sent[0]?.url).toBe("/api/gateway/prices/openai%2Fgpt-5.5");
    expect(
      within(row).getByRole("button", {
        name: "Use the default price for openai/gpt-5.5",
      }).textContent,
    ).toBe("Remove");
  });
});
