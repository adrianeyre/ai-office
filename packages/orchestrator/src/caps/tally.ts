import {
  addTokens,
  capPeriods,
  periodBounds,
  type TokenTotals,
  type TokenUsageRow,
} from "@ai-office/shared";

// The day's and the month's token use, kept in memory (PRD FR-33): the AI
// Gateway asks for an Agent's use before every call it makes, which is too
// often to add up a month of request records each time. Each period is
// read from the request history once, the first time it is asked for, and
// each request recorded after that is added as it is recorded. Other
// periods are read from the request history as they are asked for.

/** One recorded request's tokens, and whose they are. */
export interface TalliedRequest extends Omit<TokenUsageRow, "totals"> {
  readonly startedAt: Date;
  readonly totals: TokenTotals;
}

export interface UsageTally {
  /** Adds a recorded request to the periods it falls in. */
  record(request: TalliedRequest): void;
  /**
   * What requests started in [`from`, `to`) used, per Floor, Agent, issue
   * and Owner tool: from memory for the current day and month.
   */
  usage(from: Date, to: Date): Promise<TokenUsageRow[]>;
}

export interface UsageTallyOptions {
  /** Adds up the request history for [`from`, `to`). */
  readonly load: (from: Date, to: Date) => Promise<TokenUsageRow[]>;
  readonly now?: () => Date;
}

/** One period's rows, by whose they are. */
interface Window {
  readonly from: Date;
  readonly to: Date;
  readonly rows: Map<string, TokenUsageRow>;
  /** Requests recorded while it is being read, added once it is. */
  readonly pending: TalliedRequest[];
  loaded: Promise<void> | undefined;
  ready: boolean;
}

const rowKey = (row: Omit<TokenUsageRow, "totals">): string =>
  JSON.stringify([row.floorId, row.agentId, row.issue, row.ownerTool]);

const windowKey = (from: Date, to: Date): string =>
  `${from.toISOString()}/${to.toISOString()}`;

export function createUsageTally(options: UsageTallyOptions): UsageTally {
  const now = options.now ?? (() => new Date());
  const windows = new Map<string, Window>();

  const add = (window: Window, request: TalliedRequest): void => {
    const key = rowKey(request);
    const current = window.rows.get(key);
    window.rows.set(key, {
      floorId: request.floorId,
      agentId: request.agentId,
      issue: request.issue,
      ownerTool: request.ownerTool,
      totals:
        current === undefined
          ? request.totals
          : addTokens(current.totals, request.totals),
    });
  };

  /** The current day's and month's windows, dropping any that are over. */
  const current = (): Window[] => {
    const at = now();
    const keep = capPeriods.map((period) => {
      const { from, to } = periodBounds(period, at);
      const key = windowKey(from, to);
      let window = windows.get(key);
      if (window === undefined) {
        window = {
          from,
          to,
          rows: new Map(),
          pending: [],
          loaded: undefined,
          ready: false,
        };
        windows.set(key, window);
      }
      return key;
    });
    for (const key of windows.keys()) {
      if (!keep.includes(key)) {
        windows.delete(key);
      }
    }
    return [...windows.values()];
  };

  const load = (window: Window): Promise<void> => {
    window.loaded ??= options.load(window.from, window.to).then(
      (rows) => {
        for (const row of rows) {
          window.rows.set(rowKey(row), row);
        }
        for (const request of window.pending.splice(0)) {
          add(window, request);
        }
        window.ready = true;
      },
      (error: unknown) => {
        // Read again next time.
        window.loaded = undefined;
        throw error;
      },
    );
    return window.loaded;
  };

  return {
    record(request) {
      for (const window of current()) {
        if (request.startedAt >= window.from && request.startedAt < window.to) {
          if (window.ready) {
            add(window, request);
          } else if (window.loaded !== undefined) {
            // The read may have missed it: counted once it is done, at
            // worst twice, never not at all.
            window.pending.push(request);
          }
          // Before it is read, the request history it is read from has it.
        }
      }
    },

    async usage(from, to) {
      const window = current().find(
        (candidate) =>
          candidate.from.getTime() === from.getTime() &&
          candidate.to.getTime() === to.getTime(),
      );
      if (window === undefined) {
        return options.load(from, to);
      }
      await load(window);
      return [...window.rows.values()];
    },
  };
}
