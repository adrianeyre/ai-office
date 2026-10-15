import { defaultKeyProfile, type GatewayKey } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// API Key Management, against a stubbed server: the keys at a glance, each
// key's usage, its name, nickname, time zone and access, and enabling and
// disabling one of the Owner's tools' keys. A change after which a key
// signs in where it did not asks for a fresh proof of the Owner (A1-3).

const toolKey: GatewayKey = {
  id: "codex-key",
  kind: "owner_tool",
  name: "Codex",
  agentId: null,
  floorId: null,
  hint: "aio_gk_Cdx1",
  createdAt: "2026-10-09T12:00:00.000Z",
  lastUsedAt: new Date().toISOString(),
  revokedAt: null,
  profile: defaultKeyProfile,
  access: "proxy",
  enabled: true,
};

const agentKey: GatewayKey = {
  ...toolKey,
  id: "ada-key",
  kind: "agent",
  name: "Ada",
  agentId: "ada-id",
  floorId: "web-shop",
  hint: "aio_gk_Ada1",
  lastUsedAt: null,
};

const session = {
  csrfToken: "csrf-token-1",
  expiresAt: "2026-10-15T12:00:00.000Z",
};

function stubServer({
  tool = toolKey,
  signedInWith = session,
  refuseChanging,
}: {
  tool?: GatewayKey;
  signedInWith?: object;
  /** The answer to a `PATCH`, instead of making the change. */
  refuseChanging?: () => Response;
} = {}) {
  let keys = [tool, agentKey];
  const sent: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        const body: unknown = JSON.parse(init?.body as string);
        sent.push({ method, url, body });
        if (method === "PATCH" && refuseChanging !== undefined) {
          return Promise.resolve(refuseChanging());
        }
        const id = /^\/api\/gateway-keys\/([^/]+)/.exec(url)?.[1];
        // The proof is no part of the key.
        const changes = { ...(body as Record<string, unknown>) };
        delete changes["currentPassword"];
        delete changes["code"];
        keys = keys.map((key) =>
          key.id !== id
            ? key
            : url.endsWith("/profile")
              ? { ...key, profile: body as GatewayKey["profile"] }
              : { ...key, ...(changes as Partial<GatewayKey>) },
        );
        return Promise.resolve(
          Response.json(keys.find((key) => key.id === id)),
        );
      }
      switch (url) {
        case "/api/session":
          return Promise.resolve(Response.json(signedInWith));
        case "/api/totp":
          return Promise.resolve(
            Response.json({ enabled: false, recoveryCodesLeft: 0 }),
          );
        case "/api/gateway-keys":
          return Promise.resolve(Response.json({ keys }));
        case "/api/gateway-keys/usage":
          return Promise.resolve(
            Response.json({
              usage: [
                {
                  gatewayKeyId: "codex-key",
                  requests: 1234,
                  inputTokens: 50_000,
                  outputTokens: 7_000,
                  estimatedCostUsd: 3.5,
                  lastRequestAt: "2026-10-10T08:00:00.000Z",
                },
              ],
            }),
          );
        default:
          return Promise.resolve(Response.json({}, { status: 404 }));
      }
    }),
  );
  return { sent };
}

async function keyCard(name: string) {
  const heading = await screen.findByRole("heading", { level: 3, name });
  const card = heading.closest<HTMLElement>("[data-slot=card]");
  if (card === null) {
    throw new Error(`${name} is not in a card.`);
  }
  return within(card);
}

function renderPage() {
  render(
    <App
      router={createAppRouter(
        createMemoryHistory({ initialEntries: ["/api-keys"] }),
      )}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
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

describe("API Key Management", () => {
  it("shows the keys at a glance, and each key's usage", async () => {
    stubServer();
    renderPage();
    const glance = within(await screen.findByLabelText("API keys at a glance"));
    // Two keys, both enabled, one used in the last day.
    expect(
      glance.getAllByRole("definition").map((value) => value.textContent),
    ).toEqual(["2", "2", "1"]);
    const codex = await keyCard("Codex");
    const usage = within(codex.getByLabelText("Usage"));
    expect(usage.getByText("1,234")).toBeDefined();
    expect(usage.getByText("50,000")).toBeDefined();
    expect(usage.getByText("US$3.50")).toBeDefined();
    expect(codex.getAllByText("AI proxy only").length).toBeGreaterThan(0);
  });

  it("saves a key's name, nickname, time zone and access", async () => {
    const { sent } = stubServer();
    renderPage();
    const codex = await keyCard("Codex");
    const form = within(codex.getByRole("form", { name: "Codex's settings" }));
    expect(form.getByLabelText<HTMLSelectElement>("Time zone").value).toBe(
      "Europe/London",
    );
    await userEvent.clear(form.getByLabelText("Name"));
    await userEvent.type(form.getByLabelText("Name"), "Codex CLI");
    await userEvent.type(form.getByLabelText("Nickname"), "Ade");
    await userEvent.selectOptions(
      form.getByLabelText("Time zone"),
      "Asia/Tokyo",
    );
    await userEvent.selectOptions(
      form.getByLabelText("Access"),
      "proxy_and_ui",
    );
    // With UI access the enabled key signs in, so that needs a proof.
    await userEvent.type(
      form.getByLabelText("Your current password"),
      "Tr0ub4dor&3x",
    );
    await userEvent.click(form.getByRole("button", { name: "Save Codex" }));
    expect(await form.findByRole("status")).toBeDefined();
    expect(sent).toEqual([
      {
        method: "PATCH",
        url: "/api/gateway-keys/codex-key",
        body: {
          name: "Codex CLI",
          access: "proxy_and_ui",
          currentPassword: "Tr0ub4dor&3x",
        },
      },
      {
        method: "PUT",
        url: "/api/gateway-keys/codex-key/profile",
        body: { nickname: "Ade", timeZone: "Asia/Tokyo" },
      },
    ]);
  });

  it("disables and enables a tool's key, but never an Agent's", async () => {
    const { sent } = stubServer();
    renderPage();
    const codex = await keyCard("Codex");
    await userEvent.click(codex.getByRole("button", { name: "Disable Codex" }));
    expect(await codex.findByText("Disabled")).toBeDefined();
    await userEvent.click(codex.getByRole("button", { name: "Enable Codex" }));
    expect(sent.map(({ body }) => body)).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
    const ada = await keyCard("Ada");
    expect(
      ada.queryByRole("button", { name: /^(Disable|Revoke) Ada$/ }),
    ).toBeNull();
    expect(ada.getByLabelText<HTMLSelectElement>("Access").disabled).toBe(true);
  });

  it("asks for the current password before giving UI access", async () => {
    const { sent } = stubServer();
    renderPage();
    const codex = await keyCard("Codex");
    const form = within(codex.getByRole("form", { name: "Codex's settings" }));
    expect(form.queryByLabelText("Your current password")).toBeNull();
    await userEvent.selectOptions(
      form.getByLabelText("Access"),
      "proxy_and_ui",
    );
    await userEvent.click(form.getByRole("button", { name: "Save Codex" }));
    expect((await form.findByRole("alert")).textContent).toBe(
      "Enter your current password.",
    );
    expect(sent).toEqual([]);

    // Back to the AI proxy only, it asks for nothing.
    await userEvent.selectOptions(form.getByLabelText("Access"), "proxy");
    expect(form.queryByLabelText("Your current password")).toBeNull();
  });

  it("says when the current password is wrong", async () => {
    stubServer({
      refuseChanging: () =>
        Response.json(
          {
            error: "wrong_password",
            message: "That is not your current password.",
          },
          { status: 422 },
        ),
    });
    renderPage();
    const codex = await keyCard("Codex");
    const form = within(codex.getByRole("form", { name: "Codex's settings" }));
    await userEvent.selectOptions(
      form.getByLabelText("Access"),
      "proxy_and_ui",
    );
    await userEvent.type(form.getByLabelText("Your current password"), "nope");
    await userEvent.click(form.getByRole("button", { name: "Save Codex" }));
    expect((await form.findByRole("alert")).textContent).toBe(
      "That is not your current password.",
    );
    expect(form.queryByRole("status")).toBeNull();
  });

  it("asks for nothing to rename a key with UI access, take UI access away, or give it to a disabled key", async () => {
    const { sent } = stubServer({
      tool: { ...toolKey, access: "proxy_and_ui" },
    });
    renderPage();
    const codex = await keyCard("Codex");
    const form = within(codex.getByRole("form", { name: "Codex's settings" }));
    await userEvent.clear(form.getByLabelText("Name"));
    await userEvent.type(form.getByLabelText("Name"), "Codex CLI");
    await userEvent.selectOptions(form.getByLabelText("Access"), "proxy");
    expect(form.queryByLabelText("Your current password")).toBeNull();
    await userEvent.click(form.getByRole("button", { name: "Save Codex" }));
    expect(await form.findByRole("status")).toBeDefined();

    const renamed = await keyCard("Codex CLI");
    await userEvent.click(
      renamed.getByRole("button", { name: "Disable Codex CLI" }),
    );
    await renamed.findByText("Disabled");
    const settings = within(
      renamed.getByRole("form", { name: "Codex CLI's settings" }),
    );
    await userEvent.selectOptions(
      settings.getByLabelText("Access"),
      "proxy_and_ui",
    );
    expect(settings.queryByLabelText("Your current password")).toBeNull();
    await userEvent.click(
      settings.getByRole("button", { name: "Save Codex CLI" }),
    );
    expect(await settings.findByRole("status")).toBeDefined();
    expect(sent.map(({ body }) => body)).toEqual([
      { name: "Codex CLI", access: "proxy" },
      { enabled: false },
      { access: "proxy_and_ui" },
    ]);
  });

  it("asks for the current password before enabling a key with UI access", async () => {
    const { sent } = stubServer({
      tool: { ...toolKey, access: "proxy_and_ui", enabled: false },
    });
    renderPage();
    const codex = await keyCard("Codex");
    await userEvent.click(codex.getByRole("button", { name: "Enable Codex" }));
    const confirm = within(codex.getByRole("form", { name: "Enable Codex" }));
    expect(
      confirm.getByText("Enabled, Codex signs in to AI Office again."),
    ).toBeDefined();
    expect(sent).toEqual([]);

    await userEvent.type(
      confirm.getByLabelText("Your current password"),
      "Tr0ub4dor&3x",
    );
    await userEvent.click(
      confirm.getByRole("button", { name: "Yes, enable Codex" }),
    );
    expect(
      await codex.findByRole("button", { name: "Disable Codex" }),
    ).toBeDefined();
    expect(codex.queryByText("Disabled")).toBeNull();
    expect(sent).toEqual([
      {
        method: "PATCH",
        url: "/api/gateway-keys/codex-key",
        body: { enabled: true, currentPassword: "Tr0ub4dor&3x" },
      },
    ]);

    // Disabling it again asks for nothing.
    await userEvent.click(codex.getByRole("button", { name: "Disable Codex" }));
    await codex.findByText("Disabled");
    expect(sent.at(-1)?.body).toEqual({ enabled: false });
  });

  it("tells a session begun with an API key it cannot let a key sign in", async () => {
    const { sent } = stubServer({
      signedInWith: { ...session, gatewayKeyId: "laptop-key" },
    });
    renderPage();
    const codex = await keyCard("Codex");
    const form = within(codex.getByRole("form", { name: "Codex's settings" }));
    await userEvent.selectOptions(
      form.getByLabelText("Access"),
      "proxy_and_ui",
    );
    expect((await form.findByRole("note")).textContent).toContain(
      "You signed in with an API key, so you cannot do this here",
    );
    expect(form.queryByLabelText("Your current password")).toBeNull();
    expect(
      form.getByRole<HTMLButtonElement>("button", { name: "Save Codex" })
        .disabled,
    ).toBe(true);
    expect(sent).toEqual([]);
  });
});
