import type { AgentContextUsage } from "@ai-office/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ContextUsageGauge, withContextUsageEvent } from "./context-usage.tsx";

// Context Usage in the 2D views (PRD FR-85): a gauge coloured green below
// 60%, amber from 60% and red from 85%, unknown when the catalogue has no
// context window, and the Floor's list kept live by its events.

const usage = (
  contextUsage: number | null,
  overrides: Partial<AgentContextUsage> = {},
): AgentContextUsage => ({
  agentId: "ada",
  floorId: "web-shop",
  issue: 4,
  model: "claude-opus-5-5",
  inputTokens: 100_000,
  contextWindow: contextUsage === null ? null : 200_000,
  contextUsage,
  updatedAt: "2026-10-10T09:00:00.000Z",
  ...overrides,
});

describe("ContextUsageGauge", () => {
  afterEach(cleanup);

  it.each([
    [0.59, "59%", "green"],
    [0.6, "60%", "amber"],
    [0.84, "84%", "amber"],
    [0.85, "85%", "red"],
  ])("shows %s as %s in %s", (share, percent, band) => {
    render(<ContextUsageGauge usage={usage(share)} />);
    const meter = screen.getByRole("meter", { name: "Context Usage" });
    expect(meter.getAttribute("aria-valuenow")).toBe(percent.slice(0, -1));
    expect(meter.closest("[data-band]")?.getAttribute("data-band")).toBe(band);
    expect(screen.getByText(percent)).toBeDefined();
  });

  it("shows a missing context window as unknown, not 0%", () => {
    render(<ContextUsageGauge usage={usage(null)} />);
    expect(screen.getByText("Unknown")).toBeDefined();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
    expect(
      screen
        .getByLabelText(/^Context Usage: unknown/)
        .getAttribute("data-band"),
    ).toBe("unknown");
  });

  it("shows a dash without a session going", () => {
    render(<ContextUsageGauge usage={undefined} />);
    expect(screen.getByLabelText("Context Usage: no session").textContent).toBe(
      "—",
    );
  });
});

describe("withContextUsageEvent", () => {
  const event = {
    type: "agent.context_usage",
    version: 1,
    floorId: "web-shop",
    agentId: "ada",
    issue: 4,
    active: true,
    model: "claude-opus-5-5",
    inputTokens: 172_000,
    contextWindow: 200_000,
    contextUsage: 0.86,
  } as const;

  it("adds or replaces the Agent's Context Usage", () => {
    const grace = usage(0.1, { agentId: "grace" });
    expect(
      withContextUsageEvent(
        { agents: [usage(0.5), grace] },
        event,
        "2026-10-10T09:05:00.000Z",
      ),
    ).toEqual({
      agents: [
        {
          agentId: "ada",
          floorId: "web-shop",
          issue: 4,
          model: "claude-opus-5-5",
          inputTokens: 172_000,
          contextWindow: 200_000,
          contextUsage: 0.86,
          updatedAt: "2026-10-10T09:05:00.000Z",
        },
        grace,
      ],
    });
  });

  it("removes the Agent once its session has ended", () => {
    expect(
      withContextUsageEvent(
        { agents: [usage(0.5)] },
        {
          type: "agent.context_usage",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          active: false,
          contextUsage: null,
        },
        "2026-10-10T09:05:00.000Z",
      ),
    ).toEqual({ agents: [] });
  });
});
