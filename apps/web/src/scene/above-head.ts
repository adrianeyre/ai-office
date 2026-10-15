import type { StreamedEvent } from "@ai-office/events/stream";
import type {
  AgentContextUsage,
  CapUse,
  FloorTokenUsage,
} from "@ai-office/shared";

import { capState, type CapState } from "../wall-board.ts";

// What floats above each Agent's head in the 3D Office, as data, so the
// scene only draws it (above-head.tsx):
// - its Context Usage bar (PRD FR-85), while it has a session going: filled
//   and coloured by its Context Usage (green below 60%, amber from 60%, red
//   from 85%), with the percentage; it empties with a short animation at a
//   Fresh Start;
// - its tokens today (FR-62), such as "128k today", idle or not: neutral
//   below 80% of its daily Token Cap, amber from 80%, red at 100%; hovering
//   it shows this month's tokens against the monthly cap.
// One scene setting switches both off.

/** How high the display floats over the Agent: clear of a standing head and of its marker. */
export const aboveHeadHeight = 2.2;

/** How long the bar takes to empty at a Fresh Start, in seconds. */
export const freshStartSeconds = 1.2;

/**
 * A count of tokens, short enough to float over a head, never more than
 * was used: `999`, `1.2k`, `128k`, `3.4M`.
 */
export function compactTokens(tokens: number): string {
  const whole = Math.max(0, Math.floor(tokens));
  const scaled = (unit: number, suffix: string) => {
    const value = whole / unit;
    // One decimal below 10 of the unit, none from there.
    const shown =
      value < 10 ? Math.floor(value * 10 + 1e-9) / 10 : Math.floor(value);
    return `${String(shown)}${suffix}`;
  };
  return whole < 1_000
    ? String(whole)
    : whole < 1_000_000
      ? scaled(1_000, "k")
      : whole < 1_000_000_000
        ? scaled(1_000_000, "M")
        : scaled(1_000_000_000, "B");
}

/** The label of an Agent's tokens today: `128k today`. */
export const tokensTodayText = (tokens: number): string =>
  `${compactTokens(tokens)} today`;

/** This month's tokens against the monthly cap: `3.4M of 100M this month`. */
export const tokensThisMonthText = (
  used: number,
  cap: number | null,
): string =>
  cap === null
    ? `${compactTokens(used)} this month`
    : `${compactTokens(used)} of ${compactTokens(cap)} this month`;

/**
 * How the tokens label is coloured against the daily Token Cap: neutral
 * below 80%, amber (`warning`) from 80%, red (`reached`) at 100%; neutral,
 * whatever it used, without a cap.
 */
export const dailyCapState = (used: number, cap: number | null): CapState =>
  cap === null ? "neutral" : capState({ used, cap });

/** One Agent's tokens, as its display shows them. */
export interface AboveHeadTokens {
  readonly today: number;
  /** The daily Token Cap in force for it; null for none. */
  readonly dailyCap: number | null;
  readonly thisMonth: number;
  /** The monthly Token Cap in force for it; null for none. */
  readonly monthlyCap: number | null;
}

/** What one Agent's display shows. */
export interface AboveHead {
  /**
   * Its Context Usage, from 0 to 1, or null when it is not known; undefined
   * while it has no session going, which hides the bar.
   */
  readonly contextUsage: number | null | undefined;
  /** Its tokens; undefined until they are read, which hides the label. */
  readonly tokens: AboveHeadTokens | undefined;
}

const tokensOf = ({
  daily,
  monthly,
}: {
  daily: Pick<CapUse, "used" | "cap">;
  monthly: Pick<CapUse, "used" | "cap">;
}): AboveHeadTokens => ({
  today: daily.used,
  dailyCap: daily.cap,
  thisMonth: monthly.used,
  monthlyCap: monthly.cap,
});

/**
 * What each of a Floor's Agents' displays shows, by its id: its Context
 * Usage from the Agents with a session going, and its tokens from the
 * Floor's token usage. An Agent the usage does not list yet has used
 * nothing, against the caps its Floor gives its Agents.
 */
export function aboveHeads({
  agentIds,
  contextUsage,
  tokenUsage,
}: {
  readonly agentIds: readonly string[];
  readonly contextUsage: readonly AgentContextUsage[] | undefined;
  readonly tokenUsage: FloorTokenUsage | undefined;
}): ReadonlyMap<string, AboveHead> {
  return new Map(
    agentIds.map((id) => {
      const listed = tokenUsage?.agents.find(({ agentId }) => agentId === id);
      const tokens =
        listed !== undefined
          ? tokensOf(listed.caps)
          : tokenUsage === undefined
            ? undefined
            : tokensOf({
                daily: { used: 0, cap: tokenUsage.agentDefaults.daily.cap },
                monthly: { used: 0, cap: tokenUsage.agentDefaults.monthly.cap },
              });
      return [
        id,
        {
          contextUsage: contextUsage?.find(({ agentId }) => agentId === id)
            ?.contextUsage,
          tokens,
        },
      ];
    }),
  );
}

/** A Fresh Start, which empties its Agent's bar (FR-86). */
export interface FreshStartSignal {
  /** Its event's id: a later one is a later Fresh Start. */
  readonly id: number;
  readonly agentId: string;
  /** The Context Usage it emptied, from 0 to 1. */
  readonly contextUsage: number;
}

/** The Fresh Starts among `events`, oldest first. */
export function freshStartSignals(
  events: readonly StreamedEvent[],
): FreshStartSignal[] {
  return events.flatMap(({ id, event }) =>
    event.type === "agent.fresh_start"
      ? [{ id, agentId: event.agentId, contextUsage: event.contextUsage }]
      : [],
  );
}
