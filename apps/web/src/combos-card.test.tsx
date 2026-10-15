import type { AiAccount, ComboEntry } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Combos in AI Settings (PRD FR-40), against a stubbed server.

const account = (
  id: string,
  name: string,
  aiProvider: string,
  priority: number,
): AiAccount => ({
  id,
  name,
  aiProvider,
  accountType: "api_key",
  endpointUrl: null,
  region: null,
  projectId: null,
  priority,
  paused: false,
  tokenHealth: null,
  tokenExpiresAt: null,
  reauthenticationNeeded: false,
  limitReason: null,
  limitedUntil: null,
  usage: { fiveHour: null, weekly: null },
  fiveHourPauseThreshold: null,
  weeklyPauseThreshold: null,
  forcedModel: null,
  extraUsage: null,
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-10T09:00:00.000Z",
});

const accounts = [
  account("claude-1", "Claude key", "Claude", 1),
  account("grok-1", "Grok key", "Grok", 2),
];

const providers = [
  {
    aiProvider: "Claude",
    agentTool: "Claude Code",
    defaultModel: "claude-opus-5-5",
    models: [
      {
        model: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        contextWindow: 200_000,
        accountTypes: ["api_key"],
      },
      {
        model: "claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        contextWindow: 200_000,
        accountTypes: ["api_key"],
      },
    ],
    catalogueFetchedAt: "2026-10-10T09:00:00.000Z",
  },
  {
    aiProvider: "Grok",
    agentTool: "opencode",
    defaultModel: "grok-4",
    models: [
      {
        model: "grok-4",
        displayName: null,
        contextWindow: null,
        accountTypes: ["api_key"],
      },
    ],
    catalogueFetchedAt: "2026-10-10T09:00:00.000Z",
  },
];

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly csrf: string | null;
}

function stubServer(
  options: {
    combos?: ComboEntry[];
    /** What adding a Combo answers, in place of adding it. */
    refuseAdd?: { status: number; body: unknown };
  } = {},
) {
  const state = {
    settings: { enabled: false },
    combos: [...(options.combos ?? [])],
  };
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      if (method !== "GET") {
        sent.push({
          method,
          url,
          body,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
      }
      if (url === "/api/office/combos") {
        if (method === "PUT") {
          state.settings = body as typeof state.settings;
        }
        return Promise.resolve(Response.json(state.settings));
      }
      if (url === "/api/gateway/combos" && method === "POST") {
        if (options.refuseAdd !== undefined) {
          return Promise.resolve(
            Response.json(options.refuseAdd.body, {
              status: options.refuseAdd.status,
            }),
          );
        }
        const combo = {
          id: `combo-${String(state.combos.length + 1)}`,
          ...(body as Omit<ComboEntry, "id" | "createdAt" | "updatedAt">),
          createdAt: "2026-10-10T12:00:00.000Z",
          updatedAt: "2026-10-10T12:00:00.000Z",
        };
        state.combos.push(combo);
        return Promise.resolve(Response.json(combo, { status: 201 }));
      }
      if (url === "/api/gateway/combos") {
        return Promise.resolve(Response.json({ combos: state.combos }));
      }
      const match = /^\/api\/gateway\/combos\/([^/]+)$/.exec(url);
      if (match !== null) {
        const index = state.combos.findIndex(({ id }) => id === match[1]);
        if (method === "DELETE") {
          state.combos.splice(index, 1);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const combo = { ...state.combos[index], ...body } as ComboEntry;
        state.combos[index] = combo;
        return Promise.resolve(Response.json(combo));
      }
      if (url === "/api/ai-accounts") {
        return Promise.resolve(Response.json({ accounts }));
      }
      if (url === "/api/ai-providers") {
        return Promise.resolve(Response.json({ aiProviders: providers }));
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
  return { sent, state };
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
  const heading = await screen.findByRole("heading", { name: "Combos" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Combos heading is not in a card.");
  }
  return within(element);
}

const opusChain: ComboEntry = {
  id: "combo-1",
  name: "Opus chain",
  modelFamilies: ["claude-opus"],
  slots: [
    { aiAccountId: "claude-1", model: "claude-opus-5-5" },
    { aiAccountId: "gone-1", model: "claude-sonnet-5-5" },
  ],
  enabled: false,
  createdAt: "2026-10-10T11:00:00.000Z",
  updatedAt: "2026-10-10T11:00:00.000Z",
};

/** Puts `text` in a field at once: typing it key by key is slow. */
async function fill(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
) {
  await user.clear(field);
  await user.click(field);
  await user.paste(text);
}

/** A Combo's slots as its row shows them, one line each. */
const slotsShown = (row: HTMLElement, name: string): (string | null)[] =>
  within(within(row).getByRole("list", { name: `${name}'s slots` }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Combos in AI Settings", () => {
  it("are off by default, and turned on", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const toggle = await view.findByRole<HTMLInputElement>("checkbox", {
      name: /^Waterfall requests through enabled Combos/,
    });
    expect(toggle.checked).toBe(false);
    expect(view.getByText("No Combos yet.")).toBeDefined();

    await user.click(toggle);
    await user.click(view.getByRole("button", { name: "Save Combos setting" }));
    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. It applies from the next request.",
    );
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "/api/office/combos",
        body: { enabled: true },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("builds a Combo: its families, and its slots in the order they are tried", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const form = within(await view.findByRole("form", { name: "Add a Combo" }));

    await fill(user, form.getByLabelText("Name"), "Opus, then Grok");
    await fill(
      user,
      form.getByLabelText("Model families"),
      "claude-opus-5-5, gpt-5",
    );
    // The first slot's Model is offered from its AI Provider's catalogue.
    const firstModel = form.getByLabelText("Model for slot 1");
    const offered = document.getElementById(
      firstModel.getAttribute("list") ?? "",
    );
    expect(
      [...(offered?.querySelectorAll("option") ?? [])].map(
        (option) => option.value,
      ),
    ).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    await fill(user, firstModel, "claude-opus-5-5");
    await user.click(form.getByRole("button", { name: "Add a slot" }));
    await user.selectOptions(
      form.getByLabelText("AI Account for slot 2"),
      "grok-1",
    );
    await fill(user, form.getByLabelText("Model for slot 2"), "grok-4");
    // Grok first, then Claude.
    await user.click(form.getByRole("button", { name: "Move slot 2 up" }));
    await user.click(form.getByRole("button", { name: "Add Combo" }));

    const added = await view.findByRole("listitem", {
      name: "Opus, then Grok",
    });
    expect(slotsShown(added, "Opus, then Grok")).toEqual([
      "Grok key · grok-4",
      "Claude key · claude-opus-5-5",
    ]);
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/gateway/combos",
        body: {
          name: "Opus, then Grok",
          modelFamilies: ["claude-opus", "gpt-5"],
          slots: [
            { aiAccountId: "grok-1", model: "grok-4" },
            { aiAccountId: "claude-1", model: "claude-opus-5-5" },
          ],
          enabled: true,
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("enables and deletes a Combo, showing a deleted account's slot as skipped", async () => {
    const { sent } = stubServer({ combos: [opusChain] });
    const user = userEvent.setup();
    const view = await card();
    const element = await view.findByRole("listitem", { name: "Opus chain" });
    const row = within(element);
    expect(row.getByText(/Disabled/)).toBeDefined();
    expect(slotsShown(element, "Opus chain")).toEqual([
      "Claude key · claude-opus-5-5",
      "A deleted AI Account · claude-sonnet-5-5 (skipped while gone)",
    ]);

    await user.click(row.getByRole("button", { name: "Enable Opus chain" }));
    expect(
      await row.findByRole("button", { name: "Disable Opus chain" }),
    ).toBeDefined();

    await user.click(row.getByRole("button", { name: "Delete Opus chain" }));
    await user.click(
      row.getByRole("button", { name: "Yes, delete Opus chain" }),
    );
    expect(await view.findByText("No Combos yet.")).toBeDefined();

    expect(
      sent.map(({ method, url, body }) => ({ method, url, body })),
    ).toEqual([
      {
        method: "PATCH",
        url: "/api/gateway/combos/combo-1",
        body: { enabled: true },
      },
      { method: "DELETE", url: "/api/gateway/combos/combo-1", body: undefined },
    ]);
  });

  it("changes a Combo's slots", async () => {
    const { sent } = stubServer({ combos: [opusChain] });
    const user = userEvent.setup();
    const view = await card();
    const element = await view.findByRole("listitem", { name: "Opus chain" });
    const row = within(element);

    await user.click(row.getByRole("button", { name: "Edit Opus chain" }));
    const form = within(row.getByRole("form", { name: "Change Opus chain" }));
    await user.click(form.getByRole("button", { name: "Remove slot 2" }));
    // One slot left: it cannot go too.
    expect(
      form.getByRole<HTMLButtonElement>("button", { name: "Remove slot 1" })
        .disabled,
    ).toBe(true);
    await fill(
      user,
      form.getByLabelText("Model for slot 1"),
      "claude-sonnet-5-5",
    );
    await user.click(form.getByRole("button", { name: "Save Combo" }));
    await vi.waitFor(() => {
      expect(slotsShown(element, "Opus chain")).toEqual([
        "Claude key · claude-sonnet-5-5",
      ]);
    });
    expect(row.queryByRole("form")).toBeNull();

    expect(sent).toEqual([
      {
        method: "PATCH",
        url: "/api/gateway/combos/combo-1",
        body: {
          name: "Opus chain",
          modelFamilies: ["claude-opus"],
          slots: [{ aiAccountId: "claude-1", model: "claude-sonnet-5-5" }],
          enabled: false,
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("says why a Combo was refused", async () => {
    const { sent } = stubServer({
      refuseAdd: {
        status: 409,
        body: {
          error: "combo_model_family_taken",
          message:
            'The enabled Combo "Opus chain" is already assigned to claude-opus. Disable it first, or assign this one elsewhere.',
        },
      },
    });
    const user = userEvent.setup();
    const view = await card();
    const form = within(await view.findByRole("form", { name: "Add a Combo" }));

    // Checked here first: nothing is sent.
    await user.click(form.getByRole("button", { name: "Add Combo" }));
    expect((await form.findByRole("alert")).textContent).toContain(
      "Name the Combo.",
    );
    expect(sent).toEqual([]);

    await fill(user, form.getByLabelText("Name"), "Second chain");
    await fill(user, form.getByLabelText("Model families"), "claude-opus");
    await fill(
      user,
      form.getByLabelText("Model for slot 1"),
      "claude-opus-5-5",
    );
    await user.click(form.getByRole("button", { name: "Add Combo" }));
    expect(
      await form.findByText(
        'The enabled Combo "Opus chain" is already assigned to claude-opus. Disable it first, or assign this one elsewhere.',
      ),
    ).toBeDefined();
    expect(sent).toHaveLength(1);
  });
});
