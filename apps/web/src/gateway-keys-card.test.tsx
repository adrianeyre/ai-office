import { defaultOwnerProfile } from "@ai-office/shared";
import type { GatewayKey } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Gateway Keys in AI Settings (PRD FR-46), against a stubbed server that behaves
// as the API does: a key is sent once, when it is made, and never listed.
// Making one with UI access needs a fresh proof of the Owner (A1-3).

const key = "aio_gk_webtestkeyQw3Er4Ty5Ui6Op7As8Df9Gh0Jk1Lz2X";

interface Sent {
  method: string;
  url: string;
  body: unknown;
  csrf: string | null;
}

const ownerToolKey = (name: string, id: string): GatewayKey => ({
  id,
  kind: "owner_tool",
  name,
  agentId: null,
  floorId: null,
  hint: key.slice(0, 11),
  createdAt: "2026-10-09T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  profile: defaultOwnerProfile,
  access: "proxy",
  enabled: true,
});

const adaKey: GatewayKey = {
  id: "ada-key",
  kind: "agent",
  name: "Ada",
  agentId: "ada-id",
  floorId: "web-shop",
  hint: "aio_gk_Ada1",
  createdAt: "2026-10-09T11:00:00.000Z",
  lastUsedAt: "2026-10-09T11:30:00.000Z",
  revokedAt: null,
  profile: defaultOwnerProfile,
  access: "proxy",
  enabled: true,
};

const session = {
  csrfToken: "csrf-token-1",
  expiresAt: "2026-10-15T12:00:00.000Z",
};

function stubServer(
  initial: GatewayKey[] = [],
  {
    signedInWith = session,
    refuseMaking,
  }: {
    signedInWith?: object;
    /** The answer to `POST /api/gateway-keys`, instead of making it. */
    refuseMaking?: () => Response;
  } = {},
) {
  let keys = [...initial];
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/gateway-keys") && method !== "GET") {
        const body: unknown =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        sent.push({
          method,
          url,
          body,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
        if (method === "POST") {
          if (refuseMaking !== undefined) {
            return Promise.resolve(refuseMaking());
          }
          const { name } = body as { name: string };
          const made = ownerToolKey(name, `key-${String(keys.length + 1)}`);
          keys = [made, ...keys];
          return Promise.resolve(
            Response.json({ gatewayKey: made, key }, { status: 201 }),
          );
        }
        const id = decodeURIComponent(url.split("/")[3] ?? "");
        keys = keys.filter((k) => k.id !== id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/gateway-keys") {
        return Promise.resolve(Response.json({ keys }));
      }
      if (url === "/api/session") {
        return Promise.resolve(Response.json(signedInWith));
      }
      if (url === "/api/totp") {
        return Promise.resolve(
          Response.json({ enabled: false, recoveryCodesLeft: 0 }),
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
  const heading = await screen.findByRole("heading", { name: "Gateway Keys" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Gateway Keys heading is not in a card.");
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

describe("Gateway Keys in AI Settings", () => {
  it("lists the Owner's tools' keys and the Agents' keys, without the keys", async () => {
    stubServer([ownerToolKey("Codex", "codex-key"), adaKey]);
    const view = await card();
    const tools = await view.findByRole("list", {
      name: "Owner tools' Gateway Keys",
    });
    expect(
      within(tools).getByRole("listitem", { name: "Codex" }).textContent,
    ).toContain("aio_gk_webt… · Made");
    expect(
      within(tools).getByRole("listitem", { name: "Codex" }).textContent,
    ).toContain("Never used");
    const agents = view.getByRole("list", { name: "Agents' Gateway Keys" });
    expect(
      within(agents).getByRole("listitem", { name: "Ada" }).textContent,
    ).toBe(
      `Ada on web-shopaio_gk_Ada1… · Last used ${new Date("2026-10-09T11:30:00.000Z").toLocaleString()}`,
    );
    expect(document.body.innerHTML).not.toContain(key);
  });

  it("makes a key for a tool and shows it once", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText("No keys for your own tools yet.");

    await user.type(view.getByLabelText("Tool"), "Claude Code");
    // A proxy-only key signs in to nothing, so it needs no proof.
    expect(view.queryByLabelText("Your current password")).toBeNull();
    await user.click(view.getByRole("button", { name: "Make Gateway Key" }));

    const shown = await view.findByRole("status");
    expect(shown.textContent).toContain(
      "Made Claude Code. Copy its key now: it is not shown again.",
    );
    expect(
      view.getByLabelText<HTMLInputElement>("The key for Claude Code").value,
    ).toBe(key);
    // The Gateway is at AI Office's own address (one entry point).
    const { origin } = window.location;
    expect(shown.textContent).toContain(`ANTHROPIC_BASE_URL=${origin}`);
    expect(shown.textContent).toContain(`the base URL ${origin}/v1`);
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/gateway-keys",
        body: { name: "Claude Code", access: "proxy" },
        csrf: "csrf-token-1",
      },
    ]);
    expect(
      await view.findByRole("listitem", { name: "Claude Code" }),
    ).toBeTruthy();
    expect(view.getByLabelText<HTMLInputElement>("Tool").value).toBe("");

    // Done hides it for good.
    await user.click(view.getByRole("button", { name: "Done" }));
    expect(view.queryByRole("status")).toBeNull();
    expect(document.body.innerHTML).not.toContain(key);
  });

  it("asks for the current password for a key with UI access, and sends it", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.type(view.getByLabelText("Tool"), "My laptop");
    await user.selectOptions(view.getByLabelText("Access"), "proxy_and_ui");
    const current = await view.findByLabelText("Your current password");
    expect(current.getAttribute("type")).toBe("password");
    expect(current.getAttribute("autocomplete")).toBe("current-password");

    await user.click(view.getByRole("button", { name: "Make Gateway Key" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "Enter your current password.",
    );
    expect(sent).toEqual([]);

    await user.type(current, "Tr0ub4dor&3x");
    await user.click(view.getByRole("button", { name: "Make Gateway Key" }));
    expect((await view.findByRole("status")).textContent).toContain(
      "Made My laptop.",
    );
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/gateway-keys",
        body: {
          name: "My laptop",
          access: "proxy_and_ui",
          currentPassword: "Tr0ub4dor&3x",
        },
        csrf: "csrf-token-1",
      },
    ]);
    // The form is back to a proxy-only key, and the password is forgotten.
    expect(view.queryByLabelText("Your current password")).toBeNull();
  });

  it("says when the current password is wrong", async () => {
    stubServer([], {
      refuseMaking: () =>
        Response.json(
          {
            error: "wrong_password",
            message: "That is not your current password.",
          },
          { status: 422 },
        ),
    });
    const user = userEvent.setup();
    const view = await card();
    await user.type(view.getByLabelText("Tool"), "My laptop");
    await user.selectOptions(view.getByLabelText("Access"), "proxy_and_ui");
    await user.type(
      await view.findByLabelText("Your current password"),
      "not-it",
    );
    await user.click(view.getByRole("button", { name: "Make Gateway Key" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "That is not your current password.",
    );
    expect(
      view.getByLabelText<HTMLInputElement>("Your current password").value,
    ).toBe("");
    expect(view.queryByRole("status")).toBeNull();
  });

  it("tells a session begun with an API key it cannot make a key with UI access", async () => {
    const { sent } = stubServer([], {
      signedInWith: { ...session, gatewayKeyId: "laptop-key" },
    });
    const user = userEvent.setup();
    const view = await card();
    await user.type(view.getByLabelText("Tool"), "Another laptop");
    await user.selectOptions(view.getByLabelText("Access"), "proxy_and_ui");
    expect((await view.findByRole("note")).textContent).toContain(
      "You signed in with an API key, so you cannot do this here",
    );
    const make = view.getByRole<HTMLButtonElement>("button", {
      name: "Make Gateway Key",
    });
    expect(make.disabled).toBe(true);

    // A proxy-only key it may still make.
    await user.selectOptions(view.getByLabelText("Access"), "proxy");
    expect(view.queryByRole("note")).toBeNull();
    await vi.waitFor(() => {
      expect(make.disabled).toBe(false);
    });
    await user.click(make);
    await view.findByRole("status");
    expect(sent.map(({ body }) => body)).toEqual([
      { name: "Another laptop", access: "proxy" },
    ]);
  });

  it("refuses a nameless key without asking the server", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.click(view.getByRole("button", { name: "Make Gateway Key" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "Give the Gateway Key a name.",
    );
    expect(sent).toEqual([]);
  });

  it("revokes a tool's key once confirmed", async () => {
    const { sent } = stubServer([ownerToolKey("Codex", "codex-key")]);
    const user = userEvent.setup();
    const view = await card();
    await user.click(await view.findByRole("button", { name: "Revoke Codex" }));
    await user.click(view.getByRole("button", { name: "Yes, revoke Codex" }));
    expect(
      await view.findByText("No keys for your own tools yet."),
    ).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "DELETE",
        url: "/api/gateway-keys/codex-key",
        body: undefined,
        csrf: "csrf-token-1",
      },
    ]);
  });
});
