import {
  type AnalyticsBreakdown,
  type AnalyticsInsights,
  type AnalyticsSeries,
  type AnalyticsTotals,
  type AnalyticsUsageWindows,
} from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { axisTicks } from "./analytics-charts.tsx";
import { rangeBounds, usageWindowSeries } from "./analytics-page.tsx";
import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";

// The AI Gateway's analytics dashboards (PRD FR-43) against a stubbed
// server with seeded data: the headline totals, the charts over time with
// their legends, tooltips and tables, the breakdowns, the insights and the
// usage-window history, all scoped by the range above them.

const totals = (fields: Partial<AnalyticsTotals> = {}): AnalyticsTotals => ({
  requests: 0,
  errors: 0,
  errorRate: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  tokens: 0,
  estimatedCostUsd: 0,
  averageLatencyMs: null,
  averageTimeToFirstByteMs: null,
  keepAliveRequests: 0,
  keepAliveCostUsd: 0,
  ...fields,
});

/** A series over the range asked for: busy on its last bucket only. */
function seriesFor(url: URL): AnalyticsSeries {
  const from = Date.parse(url.searchParams.get("from") ?? "");
  const to = Date.parse(url.searchParams.get("to") ?? "");
  const bucket = url.searchParams.get("bucket") === "hour" ? "hour" : "day";
  const step = bucket === "hour" ? 3_600_000 : 86_400_000;
  const points: AnalyticsSeries["points"] = [];
  for (let at = from; at < to; at += step) {
    const last = at + step >= to;
    points.push({
      at: new Date(at).toISOString(),
      ...(last
        ? totals({
            requests: 40,
            errors: 4,
            errorRate: 0.1,
            inputTokens: 90_000,
            outputTokens: 30_000,
            cacheReadTokens: 250_000,
            cacheWriteTokens: 12_000,
            tokens: 120_000,
            estimatedCostUsd: 1.75,
            averageLatencyMs: 1_250,
            keepAliveRequests: 6,
            keepAliveCostUsd: 0.12,
          })
        : totals()),
    });
  }
  return {
    bucket,
    totals: totals({
      requests: 40,
      errors: 4,
      errorRate: 0.1,
      inputTokens: 90_000,
      outputTokens: 30_000,
      cacheReadTokens: 250_000,
      cacheWriteTokens: 12_000,
      tokens: 120_000,
      estimatedCostUsd: 1.75,
      averageLatencyMs: 1_250,
      keepAliveRequests: 6,
      keepAliveCostUsd: 0.12,
    }),
    points,
  };
}

const breakdowns: Record<string, AnalyticsBreakdown["items"]> = {
  model: [
    {
      key: "claude-opus-5-5",
      label: "claude-opus-5-5",
      floorId: null,
      ...totals({ requests: 30, tokens: 100_000, estimatedCostUsd: 1.5 }),
    },
    {
      key: "grok-5",
      label: "grok-5",
      floorId: null,
      ...totals({ requests: 10, tokens: 20_000, estimatedCostUsd: 0.25 }),
    },
  ],
  agent: [
    {
      key: "ada-id",
      label: "Ada",
      floorId: "web-shop",
      ...totals({
        requests: 25,
        tokens: 90_000,
        inputTokens: 60_000,
        cacheReadTokens: 20_000,
        averageLatencyMs: 900,
        averageTimeToFirstByteMs: 300,
        errorRate: 0.04,
      }),
    },
    {
      key: "linus-id",
      label: "Linus",
      floorId: "web-shop",
      ...totals({ requests: 40, tokens: 30_000 }),
    },
  ],
  floor: [
    {
      key: "web-shop",
      label: "Web shop",
      floorId: null,
      ...totals({ requests: 65, tokens: 120_000, estimatedCostUsd: 1.75 }),
    },
  ],
};

const insights: AnalyticsInsights = {
  topConsumers: [
    {
      kind: "agent",
      key: "ada-id",
      label: "Ada",
      floorId: "web-shop",
      tokens: 90_000,
      requests: 25,
      estimatedCostUsd: 1.25,
      share: 0.75,
    },
    {
      kind: "owner_tool",
      key: "laptop",
      label: "laptop",
      floorId: null,
      tokens: 30_000,
      requests: 15,
      estimatedCostUsd: 0.5,
      share: 0.25,
    },
  ],
  accountsNearLimits: [
    {
      accountId: "acc-1",
      name: "Max plan",
      aiProvider: "Claude",
      windows: [
        {
          window: "five_hour",
          utilization: 92,
          resetsAt: "2026-10-09T17:00:00.000Z",
        },
      ],
      limitReason: null,
      limitedUntil: null,
    },
    {
      accountId: "acc-2",
      name: "Spare key",
      aiProvider: "Claude",
      windows: [],
      limitReason: "rate_limited",
      limitedUntil: "2026-10-09T15:30:00.000Z",
    },
  ],
};

function usageWindowsFor(url: URL): AnalyticsUsageWindows {
  const to = Date.parse(url.searchParams.get("to") ?? "");
  return {
    accounts: [
      {
        accountId: "acc-1",
        name: "Max plan",
        aiProvider: "Claude",
        readings: [
          {
            window: "five_hour",
            utilization: 40,
            resetsAt: new Date(to).toISOString(),
            observedAt: new Date(to - 2 * 86_400_000).toISOString(),
          },
          {
            window: "five_hour",
            utilization: 92,
            resetsAt: new Date(to).toISOString(),
            observedAt: new Date(to - 3_600_000).toISOString(),
          },
          {
            window: "weekly",
            utilization: 30,
            resetsAt: new Date(to).toISOString(),
            observedAt: new Date(to - 3_600_000).toISOString(),
          },
        ],
      },
    ],
  };
}

function stubServer() {
  const asked: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const url = new URL(input, "http://localhost");
      asked.push(url);
      switch (url.pathname) {
        case "/api/analytics/series":
          return Promise.resolve(Response.json(seriesFor(url)));
        case "/api/analytics/breakdown": {
          const by = url.searchParams.get("by") ?? "";
          return Promise.resolve(
            Response.json({ by, items: breakdowns[by] ?? [] }),
          );
        }
        case "/api/analytics/insights":
          return Promise.resolve(Response.json(insights));
        case "/api/analytics/usage-windows":
          return Promise.resolve(Response.json(usageWindowsFor(url)));
        case "/api/session":
          return Promise.resolve(
            Response.json({
              csrfToken: "csrf-token-1",
              expiresAt: "2026-10-15T12:00:00.000Z",
            }),
          );
        default:
          return Promise.resolve(Response.json({}, { status: 404 }));
      }
    }),
  );
  return { asked };
}

function renderAt(path: string) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <App
      router={router}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  return router;
}

/** The card a heading names. */
async function cardOf(name: string) {
  const heading = await screen.findByRole("heading", { name });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error(`${name} is not in a card.`);
  }
  return within(element);
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the analytics dashboards", () => {
  it("shows the headline totals for the last 7 days, by the day", async () => {
    const { asked } = stubServer();
    renderAt("/analytics");
    expect(
      await screen.findByRole("heading", { name: "Analytics" }),
    ).toBeTruthy();
    const tile = async (label: string) =>
      (await screen.findByText(label, { selector: "p" })).parentElement
        ?.textContent;
    await waitFor(async () => {
      expect(await tile("Requests")).toBe("Requests40");
    });
    expect(await tile("Tokens")).toBe(
      "Tokens120K250K cache read, 12K cache write",
    );
    expect(await tile("Estimated cost")).toBe("Estimated cost$1.75");
    expect(await tile("Mean latency")).toBe("Mean latency1.3 s");
    expect(await tile("Error rate")).toBe("Error rate10%4 of 40 requests");
    // The prompt-cache keep-alives among them (FR-39), and what they cost.
    expect(await tile("Keep-alives")).toBe(
      "Keep-alives6$0.12 to keep prompt caches warm",
    );
    const series = asked.find(
      ({ pathname }) => pathname === "/api/analytics/series",
    );
    expect(series?.searchParams.get("bucket")).toBe("day");
    const span =
      Date.parse(series?.searchParams.get("to") ?? "") -
      Date.parse(series?.searchParams.get("from") ?? "");
    expect(span).toBe(7 * 86_400_000);
    expect(
      screen.getByRole("button", { name: "Last 7 days" }).ariaPressed,
    ).toBe("true");
  });

  it("charts each total over time, with a legend, a tooltip on hover and keys, and a table", async () => {
    stubServer();
    renderAt("/analytics");
    for (const title of [
      "Requests",
      "Tokens by type",
      "Estimated cost",
      "Latency",
      "Error rate",
    ]) {
      expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    }
    const tokens = await cardOf("Tokens by type");
    // Four series: a legend names them all.
    expect(
      tokens.getAllByRole("listitem").map(({ textContent }) => textContent),
    ).toEqual(["Input", "Output", "Cache read", "Cache write"]);
    // The last day's columns, hovered: every series' value.
    const buckets = tokens.getAllByTestId("chart-bucket");
    expect(buckets).toHaveLength(7);
    fireEvent.pointerEnter(buckets.at(-1) as Element);
    const tooltip = await tokens.findByRole("status");
    expect(tooltip.textContent).toContain("90KInput");
    expect(tooltip.textContent).toContain("30KOutput");
    expect(tooltip.textContent).toContain("250KCache read");
    expect(tooltip.textContent).toContain("12KCache write");
    // The same from the keyboard.
    const requests = await cardOf("Requests");
    const chart = requests.getByRole("group", { name: /^Requests\./ });
    fireEvent.focus(chart);
    expect((await requests.findByRole("status")).textContent).toContain(
      "40Requests",
    );
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(requests.getByRole("status").textContent).toContain("0Requests");
    // And without hovering: the table.
    const table = tokens.getByRole("table", {
      name: "Tokens by type",
      hidden: true,
    });
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows).toHaveLength(8);
    expect(rows.at(-1)?.textContent).toMatch(/90K30K250K12K$/);
    // A single series has no legend.
    fireEvent.blur(chart);
    expect(requests.queryByRole("status")).toBeNull();
    expect(requests.queryAllByRole("listitem")).toEqual([]);
  });

  it("charts the prompt-cache keep-alives over time", async () => {
    stubServer();
    renderAt("/analytics");
    const keepAlives = await cardOf("Prompt-cache keep-alives");
    const chart = keepAlives.getByRole("group", {
      name: /^Prompt-cache keep-alives\./,
    });
    fireEvent.focus(chart);
    expect((await keepAlives.findByRole("status")).textContent).toContain(
      "6Keep-alives",
    );
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(keepAlives.getByRole("status").textContent).toContain(
      "0Keep-alives",
    );
  });

  it("names the top consumers and the AI Accounts close to their limits", async () => {
    stubServer();
    renderAt("/analytics");
    const consumers = await cardOf("Top consumers");
    expect(
      (await consumers.findByRole("link", { name: "Ada" })).getAttribute(
        "href",
      ),
    ).toBe("/?floor=web-shop&inspect=agent%3Aada-id");
    expect(consumers.getByText(/90K tokens · 75%/)).toBeTruthy();
    expect(consumers.getByText("Owner tool")).toBeTruthy();
    const limits = await cardOf("AI Accounts near their limits");
    expect(
      (await limits.findByText(/5-hour window 92% used/)).textContent,
    ).toBe("5-hour window 92% used, resets 9 Oct, 17:00 UTC");
    expect(limits.getByText(/Held back/).textContent).toBe(
      "Held back (rate limited) until 9 Oct, 15:30 UTC",
    );
    expect(
      limits.getByRole("meter", { name: "Max plan's 5-hour window" }),
    ).toBeTruthy();
  });

  it("breaks down by Model, then by another dimension, keeping it in the address", async () => {
    const { asked } = stubServer();
    const router = renderAt("/analytics");
    const card = await cardOf("Tokens by Model");
    const bars = await card.findByRole("list", { name: "Tokens by Model" });
    expect(
      within(bars)
        .getAllByRole("listitem")
        .map(({ textContent }) => textContent),
    ).toEqual(["claude-opus-5-5100K", "grok-520K"]);
    // A bar's tooltip, on focus.
    const [first] = within(bars).getAllByRole("listitem");
    fireEvent.focus(first ?? bars);
    expect(card.getByRole("status").textContent).toContain("30requests");

    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Break down by" }),
      "agent",
    );
    const byAgent = await cardOf("Tokens by Agent");
    const agentBars = await byAgent.findByRole("list", {
      name: "Tokens by Agent",
    });
    expect(
      within(agentBars)
        .getAllByRole("listitem")
        .map(({ textContent }) => textContent),
    ).toEqual(["Ada90K", "Linus30K"]);
    expect(
      asked.some(
        (url) =>
          url.pathname === "/api/analytics/breakdown" &&
          url.searchParams.get("by") === "agent",
      ),
    ).toBe(true);
    expect(router.state.location.search).toMatchObject({ by: "agent" });
  });

  it("shows how each Floor and Agent performed, with the busiest Agents", async () => {
    stubServer();
    renderAt("/analytics");
    const floors = await cardOf("Floors");
    const webShop = await floors.findByRole("row", { name: /^Web shop/ });
    expect(
      within(webShop)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["65", "100%", "120K", "$1.75", "–", "–", "0%", "–"]);
    const agents = await cardOf("Agents");
    const ada = await agents.findByRole("row", { name: /^Ada/ });
    expect(
      within(ada)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["25", "75%", "90K", "$0", "900 ms", "300 ms", "4.0%", "25%"]);
    // The busiest by requests: Linus first.
    const busiest = agents.getByRole("list", {
      name: "The busiest Agents, by requests",
    });
    expect(
      within(busiest)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Linus40", "Ada25"]);
    for (const title of [
      "AI Providers",
      "AI Accounts",
      "Models",
      "Time to first byte",
      "Cache reads",
    ]) {
      expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    }
  });

  it("charts each AI Account's usage windows over the range", async () => {
    stubServer();
    renderAt("/analytics");
    const account = await cardOf("Max plan");
    expect(
      account.getAllByRole("listitem").map(({ textContent }) => textContent),
    ).toEqual(["5-hour window", "Weekly window"]);
    const table = account.getByRole("table", {
      name: "Max plan's usage windows",
      hidden: true,
    });
    const last = within(table).getAllByRole("row", { hidden: true }).at(-1);
    expect(last?.textContent).toMatch(/92%30%$/);
  });

  it("reads everything again, by the hour, for the last 24 hours", async () => {
    const { asked } = stubServer();
    const router = renderAt("/analytics?range=7d&by=model");
    await screen.findByRole("heading", { name: "Tokens by type" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Last 24 hours" }));
    await waitFor(() => {
      expect(
        asked.some(
          (url) =>
            url.pathname === "/api/analytics/series" &&
            url.searchParams.get("bucket") === "hour",
        ),
      ).toBe(true);
    });
    const tokens = await cardOf("Tokens by type");
    await waitFor(() => {
      expect(tokens.getAllByTestId("chart-bucket")).toHaveLength(24);
    });
    expect(router.state.location.search).toMatchObject({ range: "24h" });
  });
});

describe("the dashboards' arithmetic", () => {
  it("ends a range with the current hour or day, in whole buckets", () => {
    const now = new Date("2026-10-09T15:20:00.000Z");
    expect(rangeBounds("7d", now)).toEqual({
      from: "2026-10-03T00:00:00.000Z",
      to: "2026-10-10T00:00:00.000Z",
      bucket: "day",
    });
    expect(rangeBounds("24h", now)).toEqual({
      from: "2026-10-08T16:00:00.000Z",
      to: "2026-10-09T16:00:00.000Z",
      bucket: "hour",
    });
  });

  it("puts round ticks on a value axis", () => {
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(40)).toEqual([0, 10, 20, 30, 40]);
    expect(axisTicks(1.75)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(axisTicks(120_000)).toEqual([0, 50_000, 100_000, 150_000]);
  });

  it("keeps the highest usage reading in each bucket", () => {
    const times = ["2026-10-08T00:00:00.000Z", "2026-10-09T00:00:00.000Z"];
    const [fiveHour, weekly] = usageWindowSeries(
      [
        {
          window: "five_hour",
          utilization: 20,
          resetsAt: "2026-10-09T12:00:00.000Z",
          observedAt: "2026-10-09T01:00:00.000Z",
        },
        {
          window: "five_hour",
          utilization: 60,
          resetsAt: "2026-10-09T12:00:00.000Z",
          observedAt: "2026-10-09T09:00:00.000Z",
        },
        {
          window: "weekly",
          utilization: 5,
          resetsAt: "2026-10-12T00:00:00.000Z",
          observedAt: "2026-10-08T09:00:00.000Z",
        },
      ],
      times,
    );
    expect(fiveHour?.values).toEqual([null, 60]);
    expect(weekly?.values).toEqual([5, null]);
  });
});
