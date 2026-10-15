import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TimeChart } from "./analytics-charts.tsx";

// The analytics charts' marks (PRD FR-43): thin columns, lines that show
// every value, and a dot wherever a line alone would show nothing.

const times = [0, 1, 2, 3, 4].map((day) =>
  new Date(Date.UTC(2026, 9, 5 + day)).toISOString(),
);

afterEach(() => {
  cleanup();
});

describe("a chart over time", () => {
  it("gives a lone value between gaps a dot, as well as the line's end", () => {
    const { container } = render(
      <TimeChart
        label="Latency"
        times={times}
        bucket="day"
        kind="lines"
        format={String}
        series={[
          {
            key: "latency",
            label: "Latency",
            color: "var(--viz-series-1)",
            values: [null, 500, null, 300, 400],
          },
        ]}
      />,
    );
    // #2 alone, and the end (#5); #4 is on the line.
    expect(container.querySelectorAll("circle")).toHaveLength(2);
    const path = container.querySelector("path")?.getAttribute("d") ?? "";
    // Two runs: the lone point, then #4 to #5.
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.match(/L/g)).toHaveLength(1);
  });

  it("draws columns no wider than 24 px, each from the baseline", () => {
    const { container } = render(
      <TimeChart
        label="Requests"
        times={times.slice(0, 2)}
        bucket="day"
        kind="columns"
        format={String}
        series={[
          {
            key: "requests",
            label: "Requests",
            color: "var(--viz-series-1)",
            values: [3, 6],
          },
        ]}
      />,
    );
    const columns = [...container.querySelectorAll("path")];
    expect(columns).toHaveLength(2);
    for (const column of columns) {
      const xs = [
        ...(column.getAttribute("d") ?? "").matchAll(/[MQH]([\d.]+)/g),
      ].map((match) => Number(match[1]));
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(24);
    }
  });
});
