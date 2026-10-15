import { usageWindowLabels, type UsageReading } from "@ai-office/shared";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

// The analytics dashboards' charts (PRD FR-43), drawn as SVG and HTML in
// the app's design system: thin marks (bars at most 24px with a 4px rounded
// end, 2px lines, 8px dots with a surface ring), solid hairline grids, a
// single y-axis per chart, a legend whenever there are two series or more,
// a tooltip on hover and keyboard focus that never holds the only copy of a
// value, and a table view for every chart. Text is always in text colours;
// only marks wear the series colours (`--viz-series-*` in styles.css).

/** One series: its name, its colour slot, and a value per bucket. */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  /** A CSS colour, such as `var(--viz-series-1)`. */
  readonly color: string;
  /** One per bucket; null where there is nothing to show. */
  readonly values: readonly (number | null)[];
}

const width = 640;
const height = 220;
const margin = { top: 12, right: 16, bottom: 28, left: 56 };
const plotWidth = width - margin.left - margin.right;
const plotHeight = height - margin.top - margin.bottom;

/** A round step for an axis: 1, 2 or 5 times a power of ten. */
function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  return (
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power
  );
}

/** The y-axis ticks from 0 to just past `max`, about four of them. */
export function axisTicks(max: number): number[] {
  if (!(max > 0)) {
    return [0, 1];
  }
  const step = niceStep(max / 4);
  const ticks: number[] = [];
  for (let tick = 0; tick < max + step / 2; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  if ((ticks.at(-1) ?? 0) < max) {
    ticks.push(Number(((ticks.at(-1) ?? 0) + step).toPrecision(12)));
  }
  return ticks;
}

const utc = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options });
const dayFormat = utc({ day: "numeric", month: "short" });
const hourFormat = utc({ hour: "2-digit", minute: "2-digit" });
const fullFormat = utc({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** A bucket's start, as an axis tick says it (UTC). */
export const bucketLabel = (at: string, bucket: "hour" | "day"): string =>
  bucket === "day"
    ? dayFormat.format(new Date(at))
    : hourFormat.format(new Date(at));

/** A bucket's start in full, as the tooltip and table say it (UTC). */
const bucketTitle = (at: string, bucket: "hour" | "day"): string =>
  bucket === "day"
    ? dayFormat.format(new Date(at))
    : `${fullFormat.format(new Date(at))} UTC`;

/** Arrow keys move along the buckets; Escape leaves them. */
function useBucketFocus(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setActive((current) =>
        Math.min(count - 1, Math.max(0, (current ?? count - 1) + step)),
      );
    } else if (event.key === "Escape") {
      setActive(null);
    }
  };
  return {
    active,
    setActive,
    focusProps: {
      tabIndex: 0,
      onKeyDown,
      onFocus: () => {
        setActive((current) => current ?? count - 1);
      },
      onBlur: () => {
        setActive(null);
      },
    },
  };
}

/** The legend: a key per series, its mark's shape, its name in ink. */
export function Legend({
  series,
  mark,
}: {
  series: readonly Pick<ChartSeries, "key" | "label" | "color">[];
  mark: "bar" | "line";
}) {
  if (series.length < 2) {
    return null;
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map(({ key, label, color }) => (
        <li key={key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "inline-block",
              mark === "bar" ? "size-2.5 rounded-[2px]" : "h-0.5 w-3 rounded",
            )}
            style={{ background: color }}
          />
          {label}
        </li>
      ))}
    </ul>
  );
}

/** A chart's table view: every value, without hovering. */
export function ChartTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
}) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        Show as a table
      </summary>
      <div className="relative mt-2 max-h-72 overflow-auto">
        <table className="w-full text-left tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col" className="py-1 pr-4 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t">
                {row.map((cell, column) => (
                  <td key={column} className="py-1 pr-4">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** The tooltip's rows: each series' value first, then its name. */
function TooltipBody({
  title,
  rows,
}: {
  title: string;
  rows: readonly { key: string; label: string; color: string; value: string }[];
}) {
  return (
    <>
      <p className="mb-1 text-xs text-muted-foreground">{title}</p>
      <ul className="space-y-0.5">
        {rows.map(({ key, label, color, value }) => (
          <li key={key} className="flex items-center gap-2 whitespace-nowrap">
            <span
              aria-hidden
              className="h-0.5 w-3 rounded"
              style={{ background: color }}
            />
            <span className="font-semibold text-foreground">{value}</span>
            <span className="text-xs text-muted-foreground">{label}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A column of `height` from the baseline, its top end rounded 4px. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return [
    `M${String(x)},${String(y + h)}`,
    `V${String(y + r)}`,
    `Q${String(x)},${String(y)} ${String(x + r)},${String(y)}`,
    `H${String(x + w - r)}`,
    `Q${String(x + w)},${String(y)} ${String(x + w)},${String(y + r)}`,
    `V${String(y + h)}`,
    "Z",
  ].join(" ");
}

/**
 * A chart over time: columns (one series, or several stacked) or lines,
 * one value axis, a bucket per tick. Hover or arrow keys show every
 * series' value for a bucket.
 */
export function TimeChart({
  label,
  times,
  bucket,
  series,
  kind,
  format,
  connectGaps = false,
  max,
}: {
  /** What it shows, for assistive technology and its table. */
  label: string;
  times: readonly string[];
  bucket: "hour" | "day";
  series: readonly ChartSeries[];
  kind: "columns" | "stacked" | "lines";
  format: (value: number) => string;
  /** Join a line across buckets with no value (sparse readings). */
  connectGaps?: boolean;
  /** The top of the value axis, when it is fixed (such as 100%). */
  max?: number;
}) {
  const count = times.length;
  const { active, setActive, focusProps } = useBucketFocus(count);
  const tooltipId = useId();
  const stackTotals = times.map((_, index) =>
    series.reduce((sum, { values }) => sum + (values[index] ?? 0), 0),
  );
  const highest =
    max ??
    (kind === "stacked"
      ? Math.max(0, ...stackTotals)
      : Math.max(
          0,
          ...series.flatMap(({ values }) =>
            values.filter((value): value is number => value !== null),
          ),
        ));
  const ticks = axisTicks(highest);
  const top = ticks.at(-1) ?? 1;
  const y = (value: number) => margin.top + plotHeight * (1 - value / top);
  const band = count === 0 ? plotWidth : plotWidth / count;
  const x = (index: number) => margin.left + band * (index + 0.5);
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const labelEvery = Math.max(1, Math.ceil(count / 7));
  // Hours over more than two days are labelled by the day, at each UTC
  // midnight (about seven of them), as an hour on its own would not say
  // which day it is.
  const byDay = bucket === "hour" && count > 48;
  const dayEvery = Math.max(1, Math.ceil(count / 24 / 7));
  const labelled = (at: string, index: number): boolean => {
    if (!byDay) {
      return index % labelEvery === 0;
    }
    const start = new Date(at);
    return (
      start.getUTCHours() === 0 &&
      Math.floor(start.getTime() / 86_400_000) % dayEvery === 0
    );
  };

  const marks: ReactNode[] = [];
  if (kind === "lines") {
    for (const { key, color, values } of series) {
      const points = values.flatMap((value, index) =>
        value === null ? [] : [{ index, value }],
      );
      let path = "";
      let previous = -2;
      for (const { index, value } of points) {
        const joined = connectGaps || index === previous + 1;
        path += `${path === "" || !joined ? "M" : "L"}${String(x(index))},${String(y(value))} `;
        previous = index;
      }
      marks.push(
        <path
          key={`line-${key}`}
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />,
      );
      // A dot where the line ends, at each point when they are sparse, and
      // at a point alone between gaps, which no line would show.
      const alone = ({ index }: { index: number }) =>
        (values[index - 1] ?? null) === null &&
        (values[index + 1] ?? null) === null;
      const dotted = connectGaps
        ? points
        : points.filter(
            (point, position) => position === points.length - 1 || alone(point),
          );
      for (const { index, value } of dotted) {
        marks.push(
          <circle
            key={`dot-${key}-${String(index)}`}
            cx={x(index)}
            cy={y(value)}
            r={4}
            fill={color}
            stroke="var(--viz-surface)"
            strokeWidth={2}
          />,
        );
      }
    }
  } else {
    times.forEach((_, index) => {
      let base = 0;
      const stacked = series.filter(({ values }) => (values[index] ?? 0) > 0);
      stacked.forEach(({ key, color, values }, position) => {
        const value = values[index] ?? 0;
        const segmentTop = y(base + value);
        // A 2px surface gap between stacked segments.
        const gap = position > 0 ? 2 : 0;
        const h = Math.max(0, y(base) - segmentTop - gap);
        base += value;
        const left = x(index) - barWidth / 2;
        marks.push(
          position === stacked.length - 1 ? (
            <path
              key={`${key}-${String(index)}`}
              d={columnPath(left, segmentTop, barWidth, h)}
              fill={color}
              opacity={active === null || active === index ? 1 : 0.55}
            />
          ) : (
            <rect
              key={`${key}-${String(index)}`}
              x={left}
              y={segmentTop}
              width={barWidth}
              height={h}
              fill={color}
              opacity={active === null || active === index ? 1 : 0.55}
            />
          ),
        );
      });
    });
  }

  const shown = active === null ? undefined : times[active];
  return (
    <div className="viz space-y-3">
      <Legend series={series} mark={kind === "lines" ? "line" : "bar"} />
      <div className="relative">
        <svg
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          className="block h-auto w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="group"
          aria-label={`${label}. Use the arrow keys to read each ${bucket}.`}
          aria-describedby={shown === undefined ? undefined : tooltipId}
          onPointerLeave={() => {
            setActive(null);
          }}
          {...focusProps}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke={tick === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
                strokeWidth={1}
              />
              <text
                x={margin.left - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                fontSize={11}
                fill="var(--viz-ink-muted)"
                className="tabular-nums"
              >
                {format(tick)}
              </text>
            </g>
          ))}
          {times.map((at, index) =>
            labelled(at, index) ? (
              <text
                key={at}
                x={x(index)}
                y={height - 8}
                textAnchor="middle"
                fontSize={11}
                fill="var(--viz-ink-muted)"
              >
                {bucketLabel(at, byDay ? "day" : bucket)}
              </text>
            ) : null,
          )}
          {kind === "lines" && active !== null ? (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={margin.top}
              y2={margin.top + plotHeight}
              stroke="var(--viz-axis)"
              strokeWidth={1}
            />
          ) : null}
          {marks}
          {times.map((at, index) => (
            <rect
              key={`hit-${at}`}
              data-testid="chart-bucket"
              x={margin.left + band * index}
              y={margin.top}
              width={band}
              height={plotHeight}
              fill="transparent"
              onPointerEnter={() => {
                setActive(index);
              }}
            />
          ))}
        </svg>
        {shown !== undefined && active !== null ? (
          <div
            id={tooltipId}
            role="status"
            className="pointer-events-none absolute top-0 z-10 rounded-md border bg-card px-3 py-2 text-sm shadow-md"
            style={{
              left: `${String(Math.min(80, Math.max(20, (x(active) / width) * 100)))}%`,
              transform: "translateX(-50%)",
            }}
          >
            <TooltipBody
              title={bucketTitle(shown, bucket)}
              rows={series.map(({ key, label: name, color, values }) => ({
                key,
                label: name,
                color,
                value:
                  values[active] === null ? "–" : format(values[active] ?? 0),
              }))}
            />
          </div>
        ) : null}
      </div>
      <ChartTable
        caption={label}
        columns={[
          bucket === "day" ? "Day (UTC)" : "Hour (UTC)",
          ...series.map(({ label: name }) => name),
        ]}
        rows={times.map((at, index) => [
          bucketTitle(at, bucket),
          ...series.map(({ values }) =>
            values[index] === null ? "–" : format(values[index] ?? 0),
          ),
        ])}
      />
    </div>
  );
}

/** One bar of a bar list. */
export interface BarItem {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** More about it, for its tooltip. */
  readonly details: readonly { label: string; value: string }[];
}

/**
 * Horizontal bars, largest first, each labelled with its value at its tip;
 * past `limit` items the rest are folded into "Other".
 */
export function BarList({
  label,
  items,
  format,
  limit = 10,
}: {
  label: string;
  items: readonly BarItem[];
  format: (value: number) => string;
  limit?: number;
}) {
  const [active, setActive] = useState<string | null>(null);
  const shown =
    items.length <= limit
      ? items
      : [
          ...items.slice(0, limit - 1),
          {
            key: "\u0000other",
            label: `Other (${String(items.length - limit + 1)})`,
            value: items
              .slice(limit - 1)
              .reduce((sum, item) => sum + item.value, 0),
            details: [],
          },
        ];
  const highest = Math.max(0, ...shown.map(({ value }) => value));
  if (shown.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Nothing in this range.</p>
    );
  }
  return (
    <ul className="viz space-y-2" aria-label={label}>
      {shown.map((item) => (
        <li
          key={item.key}
          tabIndex={0}
          className="relative grid grid-cols-[minmax(6rem,12rem)_1fr] items-center gap-3 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerEnter={() => {
            setActive(item.key);
          }}
          onPointerLeave={() => {
            setActive(null);
          }}
          onFocus={() => {
            setActive(item.key);
          }}
          onBlur={() => {
            setActive(null);
          }}
        >
          <span className="truncate text-sm" title={item.label}>
            {item.label}
          </span>
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-4 rounded-r-[4px]"
              style={{
                width: `${String(highest === 0 ? 0 : Math.max(0.5, (item.value / highest) * 85))}%`,
                background: "var(--viz-series-1)",
                opacity: active === null || active === item.key ? 1 : 0.55,
              }}
            />
            <span className="text-xs text-muted-foreground tabular-nums">
              {format(item.value)}
            </span>
          </span>
          {active === item.key && item.details.length > 0 ? (
            <div
              role="status"
              className="pointer-events-none absolute top-full left-1/3 z-10 mt-1 rounded-md border bg-card px-3 py-2 text-sm shadow-md"
            >
              <TooltipBody
                title={item.label}
                rows={item.details.map(({ label: name, value }) => ({
                  key: name,
                  label: name,
                  color: "var(--viz-series-1)",
                  value,
                }))}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A share against its whole, on a lighter track of the same hue. */
export function Meter({
  value,
  max,
  color = "var(--viz-series-1)",
  label,
}: {
  value: number;
  max: number;
  color?: string;
  label: string;
}) {
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className="viz block h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: "var(--viz-track)" }}
    >
      <span
        className="block h-full rounded-full"
        style={{
          width: `${String(max === 0 ? 0 : Math.min(100, (value / max) * 100))}%`,
          background: color,
        }}
      />
    </span>
  );
}

/** Each account's readings, the highest in each bucket. */
export function usageWindowSeries(
  readings: readonly UsageReading[],
  times: readonly string[],
): ChartSeries[] {
  const starts = times.map((at) => Date.parse(at));
  const bucketOf = (at: string): number => {
    const time = Date.parse(at);
    let index = -1;
    for (const [position, start] of starts.entries()) {
      if (start <= time) {
        index = position;
      }
    }
    return index;
  };
  return (["five_hour", "weekly"] as const).map((window, slot) => {
    const values: (number | null)[] = times.map(() => null);
    for (const reading of readings) {
      const index = bucketOf(reading.observedAt);
      if (reading.window === window && index >= 0) {
        values[index] = Math.max(values[index] ?? 0, reading.utilization);
      }
    }
    return {
      key: window,
      label: `${usageWindowLabels[window]} window`,
      color: slot === 0 ? "var(--viz-series-1)" : "var(--viz-series-2)",
      values,
    };
  });
}
