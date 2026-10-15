import type { ModelMappingEntry } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Model mappings and aliases in AI Settings (PRD FR-41), against a stubbed
// server.

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
];

interface Sent {
  method: string;
  url: string;
  body: unknown;
  csrf: string | null;
}

function stubServer(
  options: {
    mappings?: ModelMappingEntry[];
    /** What adding a mapping answers, in place of adding it. */
    refuseAdd?: { status: number; body: unknown };
  } = {},
) {
  const state = { mappings: [...(options.mappings ?? [])] };
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
      if (url === "/api/gateway/model-mappings" && method === "POST") {
        if (options.refuseAdd !== undefined) {
          return Promise.resolve(
            Response.json(options.refuseAdd.body, {
              status: options.refuseAdd.status,
            }),
          );
        }
        const mapping = {
          id: `mapping-${String(state.mappings.length + 1)}`,
          ...(body as Omit<
            ModelMappingEntry,
            "id" | "createdAt" | "updatedAt"
          >),
          createdAt: "2026-10-10T12:00:00.000Z",
          updatedAt: "2026-10-10T12:00:00.000Z",
        };
        state.mappings.push(mapping);
        return Promise.resolve(Response.json(mapping, { status: 201 }));
      }
      if (url === "/api/gateway/model-mappings") {
        return Promise.resolve(Response.json({ mappings: state.mappings }));
      }
      const match = /^\/api\/gateway\/model-mappings\/([^/]+)$/.exec(url);
      if (match !== null) {
        const index = state.mappings.findIndex(({ id }) => id === match[1]);
        if (method === "DELETE") {
          state.mappings.splice(index, 1);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const mapping = {
          ...state.mappings[index],
          ...body,
        } as ModelMappingEntry;
        state.mappings[index] = mapping;
        return Promise.resolve(Response.json(mapping));
      }
      if (url === "/api/ai-accounts") {
        return Promise.resolve(Response.json({ accounts: [] }));
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
  const heading = await screen.findByRole("heading", {
    name: "Model mappings",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Model mappings heading is not in a card.");
  }
  return within(element);
}

const opusAlias: ModelMappingEntry = {
  id: "mapping-1",
  from: "opus",
  to: "claude-opus-5-5",
  aiProvider: null,
  accountType: null,
  createdAt: "2026-10-10T11:00:00.000Z",
  updatedAt: "2026-10-10T11:00:00.000Z",
};

const forSubscriptions: ModelMappingEntry = {
  id: "mapping-2",
  from: "claude-opus-5-5",
  to: "claude-sonnet-5-5",
  aiProvider: "Claude",
  accountType: "oauth",
  createdAt: "2026-10-10T11:00:00.000Z",
  updatedAt: "2026-10-10T11:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Model mappings in AI Settings", () => {
  it("says when there are none, and adds an alias and a mapping for one kind of AI Account", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    expect(
      await view.findByText(
        "No model mappings: every request is sent the Model it asks for.",
      ),
    ).toBeTruthy();

    const form = view.getByRole("form", { name: "Add a mapping" });
    await user.type(within(form).getByLabelText("Asked for"), "opus");
    await user.type(within(form).getByLabelText("Sent as"), "claude-opus-5-5");
    // An alias unless a kind is chosen.
    expect(
      within(form).getByLabelText<HTMLSelectElement>("Applies to").value,
    ).toBe("");
    await user.click(
      within(form).getByRole("button", { name: "Add the mapping" }),
    );
    const list = await view.findByRole("list", { name: "Model mappings" });
    expect(
      within(list).getByRole("listitem", {
        name: "opus (Alias, for every AI Account)",
      }).textContent,
    ).toContain("opus → claude-opus-5-5");

    // The Claude catalogue's Models are offered.
    expect(
      [...form.querySelectorAll("datalist option")].map(
        (option) => (option as HTMLOptionElement).value,
      ),
    ).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    await user.type(
      within(form).getByLabelText("Asked for"),
      "claude-opus-5-5",
    );
    await user.type(
      within(form).getByLabelText("Sent as"),
      "claude-sonnet-5-5",
    );
    await user.selectOptions(
      within(form).getByLabelText("Applies to"),
      "Claude subscription (Pro or Max)",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add the mapping" }),
    );
    await within(list).findByRole("listitem", {
      name: "claude-opus-5-5 (For Claude subscription (Pro or Max))",
    });

    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/gateway/model-mappings",
        body: {
          from: "opus",
          to: "claude-opus-5-5",
          aiProvider: null,
          accountType: null,
        },
        csrf: "csrf-token-1",
      },
      {
        method: "POST",
        url: "/api/gateway/model-mappings",
        body: {
          from: "claude-opus-5-5",
          to: "claude-sonnet-5-5",
          aiProvider: "Claude",
          accountType: "oauth",
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("changes a mapping, and deletes one once the Owner confirms", async () => {
    const { sent, state } = stubServer({
      mappings: [opusAlias, forSubscriptions],
    });
    const user = userEvent.setup();
    const view = await card();
    await user.click(
      await view.findByRole("button", {
        name: "Edit the mapping of opus (Alias, for every AI Account)",
      }),
    );
    const form = view.getByRole("form", { name: "Edit the mapping of opus" });
    await user.clear(within(form).getByLabelText("Sent as"));
    await user.type(within(form).getByLabelText("Sent as"), "claude-opus-4-5");
    await user.selectOptions(
      within(form).getByLabelText("Applies to"),
      "Anthropic Console API key",
    );
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await view.findByRole("listitem", {
      name: "opus (For Anthropic Console API key)",
    });
    expect(sent.at(-1)).toEqual({
      method: "PUT",
      url: "/api/gateway/model-mappings/mapping-1",
      body: {
        from: "opus",
        to: "claude-opus-4-5",
        aiProvider: "Claude",
        accountType: "api_key",
      },
      csrf: "csrf-token-1",
    });

    await user.click(
      view.getByRole("button", {
        name: "Delete the mapping of claude-opus-5-5 (For Claude subscription (Pro or Max))",
      }),
    );
    expect(state.mappings).toHaveLength(2);
    await user.click(view.getByRole("button", { name: "Yes, delete it" }));
    await view.findByRole("listitem", {
      name: "opus (For Anthropic Console API key)",
    });
    expect(state.mappings.map(({ id }) => id)).toEqual(["mapping-1"]);
    expect(sent.at(-1)).toMatchObject({
      method: "DELETE",
      url: "/api/gateway/model-mappings/mapping-2",
    });
  });

  it("says why a mapping was refused, by the form or by the API", async () => {
    const { sent } = stubServer({
      refuseAdd: {
        status: 409,
        body: {
          error: "model_mapping_taken",
          message: "opus is already mapped as an alias.",
        },
      },
    });
    const user = userEvent.setup();
    const view = await card();
    const form = await view.findByRole("form", { name: "Add a mapping" });
    await user.type(within(form).getByLabelText("Asked for"), "opus");
    await user.type(within(form).getByLabelText("Sent as"), "gpt-5-codex");
    await user.selectOptions(
      within(form).getByLabelText("Applies to"),
      "Claude subscription (Pro or Max)",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add the mapping" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "gpt-5-codex is ChatGPT's, but the mapping is for Claude accounts.",
    );
    expect(sent).toEqual([]);

    await user.selectOptions(
      within(form).getByLabelText("Applies to"),
      "Every AI Account (an alias)",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add the mapping" }),
    );
    await vi.waitFor(() => {
      expect(within(form).getByRole("alert").textContent).toBe(
        "opus is already mapped as an alias.",
      );
    });
    expect(sent).toHaveLength(1);
  });
});
