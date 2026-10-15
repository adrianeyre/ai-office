import type { AiProviderEntry, CatalogueRefresh } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The AI Providers in AI Settings (PRD FR-15, FR-41), against a stubbed server
// that behaves as the API does: the catalogue fills when it is refreshed,
// and a default Model can be chosen only from it.

const fetchedAt = "2026-10-09T12:00:00.000Z";

const empty = (
  aiProvider: AiProviderEntry["aiProvider"],
  agentTool: AiProviderEntry["agentTool"],
  defaultModel: string | null = null,
): AiProviderEntry => ({
  aiProvider,
  agentTool,
  defaultModel,
  models: [],
  catalogueFetchedAt: null,
});

const catalogue: Record<string, AiProviderEntry["models"]> = {
  Claude: [
    {
      model: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      contextWindow: null,
      accountTypes: ["api_key"],
    },
    {
      model: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      contextWindow: null,
      accountTypes: ["api_key"],
    },
  ],
  ChatGPT: [
    {
      model: "gpt-5-codex",
      displayName: "gpt-5-codex",
      contextWindow: 272_000,
      accountTypes: ["oauth"],
    },
  ],
};

function stubServer(
  edit: (entry: AiProviderEntry) => AiProviderEntry = (entry) => entry,
) {
  let providers: AiProviderEntry[] = [
    empty("Claude", "Claude Code", "claude-opus-5-5"),
    empty("ChatGPT", "Codex"),
    empty("Grok", "opencode"),
    empty("Gemini", "opencode"),
  ].map(edit);
  const sent: {
    method: string;
    url: string;
    body: unknown;
    csrf: string | null;
  }[] = [];
  const refreshed: CatalogueRefresh = {
    refreshed: [
      { aiProvider: "Claude", accountType: "api_key", models: 2 },
      { aiProvider: "ChatGPT", accountType: "oauth", models: 1 },
    ],
    failed: [
      {
        aiProvider: "Grok",
        accountType: "api_key",
        message: "The AI Provider's model list answered 503.",
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({
          method,
          url,
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : undefined,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
      }
      if (url === "/api/model-catalogue/refresh" && method === "POST") {
        providers = providers.map((provider) => ({
          ...provider,
          models: catalogue[provider.aiProvider] ?? [],
          catalogueFetchedAt:
            catalogue[provider.aiProvider] === undefined ? null : fetchedAt,
        }));
        return Promise.resolve(Response.json(refreshed));
      }
      const put = /^\/api\/ai-providers\/(\w+)$/.exec(url);
      if (put !== null && method === "PUT") {
        const { defaultModel } = JSON.parse(init?.body as string) as {
          defaultModel: string;
        };
        const provider = providers.find(
          ({ aiProvider }) => aiProvider === put[1],
        );
        if (defaultModel.startsWith("claude-") && put[1] !== "Claude") {
          return Promise.resolve(
            Response.json(
              {
                error: "model_not_in_catalogue",
                message: `"${defaultModel}" is Claude's Model, not ${put[1] ?? ""}'s.`,
              },
              { status: 400 },
            ),
          );
        }
        providers = providers.map((entry) =>
          entry === provider ? { ...entry, defaultModel } : entry,
        );
        return Promise.resolve(new Response(null, { status: 204 }));
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
  const heading = await screen.findByRole("heading", { name: "AI Providers" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The AI Providers heading is not in a card.");
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

describe("the AI Providers in AI Settings", () => {
  it("lists Claude, ChatGPT, Grok and Gemini, saying which cannot be used yet", async () => {
    stubServer();
    const view = await card();
    const forms = await view.findAllByRole("form");
    expect(forms.map((form) => form.getAttribute("aria-label"))).toEqual([
      "Claude",
      "ChatGPT",
      "Grok",
      "Gemini",
    ]);
    const claude = view.getByRole("form", { name: "Claude" });
    expect(claude.textContent).toContain("Runs Claude Code in sandboxes");
    expect(
      within(claude).getByLabelText<HTMLInputElement>("Default Model").value,
    ).toBe("claude-opus-5-5");
    const chatgpt = view.getByRole("form", { name: "ChatGPT" });
    expect(chatgpt.textContent).toContain("Runs Codex in sandboxes");
    expect(chatgpt.textContent).toContain(
      "No default Model: no Agent can use ChatGPT until you choose one.",
    );
    expect(chatgpt.textContent).toContain(
      "The catalogue has no ChatGPT Models yet.",
    );
    // With nothing to pick from, the Model is typed in.
    expect(
      within(chatgpt).getByLabelText<HTMLInputElement>("Default Model").type,
    ).toBe("text");
  });

  it("sets a default Model the catalogue does not list, typed in", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const chatgpt = await view.findByRole("form", { name: "ChatGPT" });
    await user.type(
      within(chatgpt).getByLabelText("Default Model"),
      " gpt-5.5-codex ",
    );
    await user.click(
      within(chatgpt).getByRole("button", { name: "Save ChatGPT's default" }),
    );
    expect(sent.at(-1)).toMatchObject({
      method: "PUT",
      url: "/api/ai-providers/ChatGPT",
      body: { defaultModel: "gpt-5.5-codex" },
    });
    const saved = await view.findByRole("form", { name: "ChatGPT" });
    await within(saved).findByDisplayValue("gpt-5.5-codex");
    expect(saved.textContent).not.toContain("No default Model");

    // Another AI Provider's Model is refused, saying why.
    const grok = view.getByRole("form", { name: "Grok" });
    await user.type(
      within(grok).getByLabelText("Default Model"),
      "claude-opus-5-5",
    );
    await user.click(
      within(grok).getByRole("button", { name: "Save Grok's default" }),
    );
    expect((await within(grok).findByRole("alert")).textContent).toContain(
      "is Claude's Model, not Grok's",
    );
  });

  it("says why an AI Provider the Owner has an AI Account for has no Models", async () => {
    stubServer((entry) =>
      entry.aiProvider === "ChatGPT"
        ? {
            ...entry,
            hasAccount: true,
            catalogueError: "The AI Provider's model list answered 400.",
          }
        : entry.aiProvider === "Grok"
          ? { ...entry, hasAccount: true, catalogueError: null }
          : entry,
    );
    const view = await card();
    const chatgpt = await view.findByRole("form", { name: "ChatGPT" });
    expect(chatgpt.textContent).toContain(
      "Your ChatGPT AI Account's Models could not be fetched (The AI Provider's model list answered 400.)",
    );
    expect(chatgpt.textContent).not.toContain("Add an AI Account");
    expect(view.getByRole("form", { name: "Grok" }).textContent).toContain(
      "refresh the model catalogue to fetch them from your AI Account",
    );
    expect(view.getByRole("form", { name: "Gemini" }).textContent).toContain(
      "Add an AI Account for Gemini",
    );
  });

  it("refreshes the catalogue, then sets a default Model from it", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findAllByRole("form");

    await user.click(
      view.getByRole("button", { name: "Refresh the model catalogue" }),
    );
    const report = await view.findByRole("status", {
      name: "Catalogue refreshed",
    });
    expect(report.textContent).toContain("Claude (API key): 2 Models.");
    expect(report.textContent).toContain("ChatGPT (subscription): 1 Models.");
    expect(report.textContent).toContain(
      "Grok (API key) kept its last list: The AI Provider's model list answered 503.",
    );

    const chatgpt = view.getByRole("form", { name: "ChatGPT" });
    const select = await within(chatgpt).findByLabelText("Default Model");
    expect(
      [...(select as HTMLSelectElement).options].map(({ text }) => text),
    ).toEqual([
      "Choose a Model",
      "gpt-5-codex · 272,000 tokens",
      "Another Model, typed in",
    ]);
    await user.selectOptions(select, "gpt-5-codex");
    await user.click(
      within(chatgpt).getByRole("button", { name: "Save ChatGPT's default" }),
    );
    expect(
      sent.map(({ method, url, body, csrf }) => [method, url, body, csrf]),
    ).toEqual([
      ["POST", "/api/model-catalogue/refresh", {}, "csrf-token-1"],
      [
        "PUT",
        "/api/ai-providers/ChatGPT",
        { defaultModel: "gpt-5-codex" },
        "csrf-token-1",
      ],
    ]);
    const saved = await view.findByRole("form", { name: "ChatGPT" });
    await within(saved).findByDisplayValue("gpt-5-codex · 272,000 tokens");
    expect(saved.textContent).not.toContain("No default Model");

    // Claude's default, now in the catalogue, is changed the same way.
    const claude = view.getByRole("form", { name: "Claude" });
    expect(claude.textContent).not.toContain("(not in the catalogue)");
    await user.selectOptions(
      within(claude).getByLabelText("Default Model"),
      "claude-sonnet-5-5",
    );
    await user.click(
      within(claude).getByRole("button", { name: "Save Claude's default" }),
    );
    expect(sent.at(-1)).toMatchObject({
      url: "/api/ai-providers/Claude",
      body: { defaultModel: "claude-sonnet-5-5" },
    });
  });
});
