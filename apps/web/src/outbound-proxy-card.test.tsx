import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The outbound proxy in AI Settings (PRD FR-35), against a stubbed server
// that, like the real one, never sends the password back.

interface Stored {
  url: string | null;
  username: string | null;
  password: string | null;
  noProxy: string[];
}

function stubServer(initial: Partial<Stored> = {}) {
  const state: Stored = {
    url: null,
    username: null,
    password: null,
    noProxy: [],
    ...initial,
  };
  const shown = () => ({
    url: state.url,
    username: state.username,
    hasPassword: state.password !== null,
    noProxy: state.noProxy,
  });
  const puts: { body: Record<string, unknown>; csrf: string | null }[] = [];
  const answers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/outbound-proxy" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.url = (body["url"] as string | null) ?? null;
        state.username = (body["username"] as string | null) ?? null;
        if (state.url === null || state.username === null) {
          state.password = null;
        } else if (body["password"] !== undefined) {
          state.password = body["password"] as string | null;
        }
        state.noProxy = (body["noProxy"] as string[] | undefined) ?? [];
        answers.push(JSON.stringify(shown()));
        return Promise.resolve(Response.json(shown()));
      }
      if (url === "/api/office/outbound-proxy") {
        return Promise.resolve(Response.json(shown()));
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-15T12:00:00.000Z",
            // ALLOWED_INTERNAL_HOSTS, as the server sends it (ADR 0007):
            // the Owner's proxy.
            allowedInternalHosts: [".corp"],
          }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { puts, answers, state };
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
    name: "Outbound proxy",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Outbound proxy heading is not in a card.");
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

describe("the outbound proxy in AI Settings", () => {
  it("sets a proxy with a username, a password and hosts to reach directly, clearing the password once sent", async () => {
    const { puts, answers } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const url = await view.findByLabelText<HTMLInputElement>("Proxy URL");
    expect(url.value).toBe("");
    await user.type(url, "http://proxy.corp:3128");
    await user.type(view.getByLabelText("Username"), "office");
    const password = view.getByLabelText<HTMLInputElement>("Password");
    expect(password.type).toBe("password");
    await user.type(password, "pr0xy-pa55");
    await user.type(
      view.getByLabelText("Reach directly"),
      "ollama.lan{enter}.internal",
    );
    await user.click(view.getByRole("button", { name: "Save proxy" }));

    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next request.",
    );
    expect(puts).toEqual([
      {
        body: {
          url: "http://proxy.corp:3128",
          username: "office",
          password: "pr0xy-pa55",
          noProxy: ["ollama.lan", ".internal"],
        },
        csrf: "csrf-token-1",
      },
    ]);
    // Never sent back, and gone from the page.
    expect(answers.join("")).not.toContain("pr0xy-pa55");
    expect(view.getByLabelText<HTMLInputElement>("Password").value).toBe("");
    expect(
      view.getByText(
        "A password is stored. Empty keeps it; it is never shown again.",
      ),
    ).toBeDefined();
  });

  it("keeps the stored password when it is left empty, and removes it when asked", async () => {
    const { puts } = stubServer({
      url: "http://proxy.corp:3128",
      username: "office",
      password: "pr0xy-pa55",
    });
    const user = userEvent.setup();
    const view = await card();
    const url = await view.findByLabelText<HTMLInputElement>("Proxy URL");
    expect(url.value).toBe("http://proxy.corp:3128");
    await user.clear(url);
    await user.type(url, "http://proxy.corp:8080");
    await user.click(view.getByRole("button", { name: "Save proxy" }));
    await view.findByRole("status");
    expect(puts[0]?.body).toEqual({
      url: "http://proxy.corp:8080",
      username: "office",
      noProxy: [],
    });

    await user.click(view.getByLabelText("Remove the stored password"));
    await user.click(view.getByRole("button", { name: "Save proxy" }));
    await vi.waitFor(() => {
      expect(puts).toHaveLength(2);
    });
    expect(puts[1]?.body).toMatchObject({ password: null });
  });

  it("turns the proxy off when its URL is emptied", async () => {
    const { puts } = stubServer({
      url: "http://proxy.corp:3128",
      noProxy: ["ollama.lan"],
    });
    const user = userEvent.setup();
    const view = await card();
    await user.clear(await view.findByLabelText("Proxy URL"));
    await user.click(view.getByRole("button", { name: "Save proxy" }));
    await view.findByRole("status");
    expect(puts.map(({ body }) => body)).toEqual([{ url: null }]);
  });

  it("says what is wrong with a proxy it cannot take", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.type(
      await view.findByLabelText("Proxy URL"),
      "http://office:secret@proxy.corp:3128",
    );
    await user.click(view.getByRole("button", { name: "Save proxy" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "Leave credentials out of the proxy URL; the username and password have their own fields.",
    );
    expect(puts).toEqual([]);
  });
});
