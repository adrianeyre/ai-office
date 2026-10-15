import type { StorageUsage } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { formatBytes } from "./storage-card.tsx";
import { location } from "./totp-settings.tsx";

// The prompt-cache TTL and Storage in Admin (PRD §6.8, §7), against a
// stubbed server.

function stubServer() {
  const state: { ttl: string; usage: StorageUsage } = {
    ttl: "as_sent",
    usage: {
      databaseBytes: 52 * 1024 * 1024,
      categories: [
        {
          category: "activity",
          rows: 1200,
          bytes: 3 * 1024 * 1024,
          oldest: "2026-01-01T00:00:00.000Z",
        },
        { category: "request_bodies", rows: 40, bytes: 2048, oldest: null },
        { category: "requests", rows: 40, bytes: 4096, oldest: null },
        { category: "usage_history", rows: 0, bytes: 0, oldest: null },
        { category: "sign_ins", rows: 3, bytes: 1024, oldest: null },
      ],
    },
  };
  const sent: { url: string; body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : {};
      if (method !== "GET") {
        sent.push({
          url,
          body,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
      }
      if (url === "/api/office/prompt-cache") {
        if (method === "PUT") {
          state.ttl = (body as { ttl: string }).ttl;
        }
        return Promise.resolve(Response.json({ ttl: state.ttl }));
      }
      if (url === "/api/office/storage") {
        return Promise.resolve(Response.json(state.usage));
      }
      if (url === "/api/office/storage/prune") {
        const { category } = body as { category: string };
        const deleted = 1000;
        state.usage = {
          ...state.usage,
          categories: state.usage.categories.map((each) =>
            each.category === category ? { ...each, rows: 200 } : each,
          ),
        };
        return Promise.resolve(Response.json({ category, deleted }));
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

async function cardTitled(name: string) {
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
  const heading = await screen.findByRole("heading", { name });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error(`The ${name} heading is not in a card.`);
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

describe("the prompt-cache TTL in Admin", () => {
  it("leaves TTLs as sent by default, and sets one with its button", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await cardTitled("Prompt cache TTL");
    const asSent = await view.findByRole("button", { name: "As sent" });
    expect(asSent.getAttribute("aria-pressed")).toBe("true");

    await user.click(view.getByRole("button", { name: "1 hour" }));
    await waitFor(() => {
      expect(
        view
          .getByRole("button", { name: "1 hour" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
    expect(asSent.getAttribute("aria-pressed")).toBe("false");
    expect(view.getByRole("status").textContent).toBe("Saved: 1 hour.");
    expect(sent).toEqual([
      {
        url: "/api/office/prompt-cache",
        body: { ttl: "1h" },
        csrf: "csrf-token-1",
      },
    ]);
  });
});

describe("storage in Admin", () => {
  it("shows each history's size, and deletes the oldest once confirmed", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await cardTitled("Storage");
    expect((await view.findByText(/The database takes/)).textContent).toBe(
      "The database takes 52 MB.",
    );
    const activity = view.getByRole("listitem", { name: "Activity" });
    expect(activity.textContent).toContain("1,200 rows · 3.0 MB");
    expect(activity.textContent).toContain("The last 30 days are always kept.");

    // Fewer days than are kept: refused before anything is sent.
    const days = within(activity).getByLabelText("Delete older than");
    await user.clear(days);
    await user.type(days, "3");
    expect(
      within(activity).getByRole<HTMLButtonElement>("button", {
        name: "Delete activity older than 3 days",
      }).disabled,
    ).toBe(true);

    await user.clear(days);
    await user.type(days, "30");
    await user.click(
      within(activity).getByRole("button", {
        name: "Delete activity older than 30 days",
      }),
    );
    expect(sent).toEqual([]);
    expect(activity.textContent).toContain(
      "Delete activity older than 30 days? It cannot be undone.",
    );
    await user.click(
      within(activity).getByRole("button", { name: "Yes, delete it" }),
    );
    await waitFor(() => {
      expect(within(activity).getByRole("status").textContent).toBe(
        "Deleted 1,000 rows.",
      );
    });
    expect(sent).toEqual([
      {
        url: "/api/office/storage/prune",
        body: { category: "activity", olderThanDays: 30 },
        csrf: "csrf-token-1",
      },
    ]);
    await waitFor(() => {
      expect(
        view.getByRole("listitem", { name: "Activity" }).textContent,
      ).toContain("200 rows");
    });
  });

  it("deletes every request body when asked for 0 days", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await cardTitled("Storage");
    const bodies = await view.findByRole("listitem", {
      name: "Request and response bodies",
    });
    const days = within(bodies).getByLabelText("Delete older than");
    await user.clear(days);
    await user.type(days, "0");
    await user.click(
      within(bodies).getByRole("button", {
        name: "Delete request and response bodies older than 0 days",
      }),
    );
    expect(bodies.textContent).toContain(
      "Delete request and response bodies of every age?",
    );
    await user.click(
      within(bodies).getByRole("button", { name: "Yes, delete it" }),
    );
    await waitFor(() => {
      expect(sent).toEqual([
        {
          url: "/api/office/storage/prune",
          body: { category: "request_bodies", olderThanDays: 0 },
          csrf: "csrf-token-1",
        },
      ]);
    });
  });

  it("formats sizes", () => {
    expect(formatBytes(null)).toBe("unknown");
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024 * 1024)).toBe("20 GB");
  });
});
