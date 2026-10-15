import {
  noTokens,
  randomAvatar,
  type OfficeTokenUsage,
  type TokenTotals,
} from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The office's Token Caps in AI Settings (PRD FR-31, FR-32), against a stubbed
// server: the daily and monthly defaults, the Office's use against them,
// per Floor and per Owner tool.

const totals = (tokens: number, extra: Partial<TokenTotals> = {}) => ({
  ...noTokens,
  requests: 1,
  inputTokens: tokens,
  tokens,
  ...extra,
});

const usage = (): OfficeTokenUsage => ({
  caps: { daily: 5_000_000, monthly: 100_000_000 },
  usage: {
    daily: totals(1_500, { cacheReadTokens: 9_000, estimatedCostUsd: 0.25 }),
    monthly: totals(4_000_000),
  },
  busiestAgents: {
    daily: {
      floorId: "web-shop",
      agentId: "ada-id",
      use: { level: "agent", cap: 2_000, used: 1_490 },
    },
    monthly: null,
  },
  floors: [
    {
      floorId: "web-shop",
      usage: { daily: totals(1_490), monthly: totals(3_999_990) },
    },
  ],
  ownerTools: [
    { ownerTool: "laptop", usage: { daily: totals(10), monthly: totals(10) } },
  ],
});

function stubServer() {
  let state = usage();
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/token-caps" && init?.method === "PUT") {
        const body = JSON.parse(
          init.body as string,
        ) as OfficeTokenUsage["caps"];
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state = { ...state, caps: body };
        return Promise.resolve(Response.json(state));
      }
      if (url === "/api/office/token-caps") {
        return Promise.resolve(Response.json(state));
      }
      if (url === "/api/floors") {
        return Promise.resolve(
          Response.json({
            floors: [
              {
                id: "web-shop",
                repository: "adrianeyre/web-shop",
                githubRepositoryId: 101,
                template: { id: "development", name: "Development" },
                theme: "office" as const,
                name: "Web Shop",
                defaultBranch: "main",
                setupCommand: "",
                testCommand: "",
                mergePolicy: "send_to_me",
                roundCap: 3,
                tokenCaps: { daily: null, monthly: null },
                concurrencyLimit: null,
                priority: 0,
                requiredReviewerAgentIds: [],
                planApproval: true,
                mostAgents: 8,
                spinOffFromChat: true,
                hourlyStatusUpdates: true,
                freshStartThreshold: 85,
                gitIdentity: null,
                createdAt: "2026-10-08T12:00:00.000Z",
                archivedAt: null,
              },
            ],
          }),
        );
      }
      if (url === "/api/floors/web-shop/agents") {
        return Promise.resolve(
          Response.json({
            agents: [
              {
                id: "ada-id",
                floorId: "web-shop",
                name: "Ada",
                role: "coder",
                stage: "work",
                aiProvider: "Claude",
                model: "claude-opus-5-5",
                modelOverride: null,
                effort: null,
                extraInstructions: "",
                freshStartThreshold: null,
                enabled: true,
                avatar: randomAvatar(),
                tokenCaps: { daily: 2_000, monthly: null },
                createdAt: "2026-10-08T12:00:00.000Z",
                leavingAt: null,
                contractor: null,
              },
            ],
          }),
        );
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
  const heading = await screen.findByRole("heading", { name: "Token Caps" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Token Caps heading is not in a card.");
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

describe("the office's Token Caps in AI Settings", () => {
  it("shows the caps and the Office's use against them", async () => {
    stubServer();
    const tokenCaps = await card();
    expect(
      await tokenCaps.findByLabelText<HTMLInputElement>("Daily Token Cap"),
    ).toHaveProperty("value", "5000000");
    expect(
      tokenCaps.getByLabelText<HTMLInputElement>("Monthly Token Cap").value,
    ).toBe("100000000");
    const nearest = await tokenCaps.findByText(/Nearest its cap today/);
    expect(nearest.textContent).toBe(
      "Nearest its cap today: Ada, 1,490 of 2,000 (the Agent's own).",
    );
    expect(
      tokenCaps.getByText("No Agent has used any this month."),
    ).toBeTruthy();
    expect(tokenCaps.getByLabelText("The Office's use").textContent).toBe(
      "Today1,500 tokens (cache reads 9,000) · about $0.25This month4,000,000 tokens (cache reads 0) · about $0.00",
    );
    const byFloor = tokenCaps.getByRole("table", { name: "By Floor" });
    expect(
      within(byFloor).getByRole("row", { name: /Web Shop/ }).textContent,
    ).toBe("Web Shop1,4903,999,990");
    const byTool = tokenCaps.getByRole("table", { name: "By Owner tool" });
    expect(
      within(byTool).getByRole("row", { name: /laptop/ }).textContent,
    ).toBe("laptop1010");
  });

  it("saves new caps, and refuses one that is not a whole number above 0 before sending", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const tokenCaps = await card();
    const daily = await tokenCaps.findByLabelText("Daily Token Cap");
    await user.clear(daily);
    await user.type(daily, "0");
    await user.click(
      tokenCaps.getByRole("button", { name: "Save Token Caps" }),
    );
    expect((await tokenCaps.findByRole("alert")).textContent).toBe(
      "A Token Cap must be more than 0 tokens.",
    );
    expect(puts).toEqual([]);

    await user.clear(daily);
    await user.type(daily, "2500000");
    await user.click(
      tokenCaps.getByRole("button", { name: "Save Token Caps" }),
    );
    expect((await tokenCaps.findByRole("status")).textContent).toContain(
      "Saved.",
    );
    expect(puts).toEqual([
      {
        body: { daily: 2_500_000, monthly: 100_000_000 },
        csrf: "csrf-token-1",
      },
    ]);
  });
});
