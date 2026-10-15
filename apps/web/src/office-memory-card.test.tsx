import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The office-wide memory in Admin (PRD FR-54, FR-56), against a stubbed
// server that refuses a line that looks like a credential, as the real one
// does.

function stubServer() {
  const state = {
    memory: { content: "", updatedAt: null as string | null },
  };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/memory/office" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as { content: string };
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        if (body.content.includes("sk-ant-")) {
          return Promise.resolve(
            Response.json(
              {
                error: "memory_holds_secret",
                message:
                  "The office-wide memory was not saved: something in it looks like a credential, and memory never holds one.",
                problems: [
                  "Line 2 looks like a credential: take the secret out.",
                ],
              },
              { status: 422 },
            ),
          );
        }
        state.memory = {
          content: body.content,
          updatedAt: "2026-10-09T12:00:00.000Z",
        };
        return Promise.resolve(Response.json(state.memory));
      }
      if (url === "/api/memory/office") {
        return Promise.resolve(Response.json(state.memory));
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
  return { puts, state };
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
    name: "Office-wide memory",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The office-wide memory heading is not in a card.");
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
});

describe("the office-wide memory in Admin", () => {
  it("is saved as the Owner writes it, with the session's CSRF token", async () => {
    const { puts, state } = stubServer();
    const within = await card();
    const box = await within.findByRole("textbox", {
      name: "Memory (Markdown)",
    });
    const save = within.getByRole("button", {
      name: "Save office-wide memory",
    });
    expect(save).toHaveProperty("disabled", true);
    await userEvent.type(box, "- Use pnpm.");
    expect(within.getByText(/11 of 12,000 characters/)).toBeTruthy();
    await userEvent.click(save);

    expect(puts).toEqual([
      { body: { content: "- Use pnpm." }, csrf: "csrf-token-1" },
    ]);
    expect(await within.findByRole("status")).toHaveProperty(
      "textContent",
      "Saved.",
    );
    expect(state.memory.content).toBe("- Use pnpm.");
    expect(save).toHaveProperty("disabled", true);
  });

  it("shows which lines look like a credential when the save is refused, keeping what was written", async () => {
    stubServer();
    const within = await card();
    const box = await within.findByRole("textbox", {
      name: "Memory (Markdown)",
    });
    await userEvent.type(box, "- Use pnpm.{enter}- Key: sk-ant-api03-abc");
    await userEvent.click(
      within.getByRole("button", { name: "Save office-wide memory" }),
    );
    const alert = await within.findByRole("alert");
    expect(
      within.getAllByRole("listitem").map(({ textContent }) => textContent),
    ).toEqual([
      "The office-wide memory was not saved: something in it looks like a credential, and memory never holds one.",
      "Line 2 looks like a credential: take the secret out.",
    ]);
    expect(alert).toBeTruthy();
    expect(box).toHaveProperty("value", "- Use pnpm.\n- Key: sk-ant-api03-abc");
    expect(within.queryByRole("status")).toBeNull();
  });

  it("is brought into view when the address names it, as the bookshelf's link does", async () => {
    stubServer();
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      function (this: HTMLElement) {
        scrolled.push(this.id);
      },
    );
    window.history.replaceState(null, "", "#office-wide-memory");
    try {
      const within = await card();
      await within.findByRole("textbox", { name: "Memory (Markdown)" });
      expect(scrolled).toContain("office-wide-memory");
    } finally {
      window.history.replaceState(null, "", "#");
      vi.restoreAllMocks();
    }
  });
});
