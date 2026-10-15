import type { StatusUpdate } from "@ai-office/shared";

import type { FloorStore } from "../floors/store.ts";
import type { WorkQueueStore } from "../work/store.ts";
import type { StatusUpdates } from "./status-update.ts";

// A Floor's hourly Status update (PRD FR-23a): every hour, each Floor in
// use whose Agents are working gives one, saying what each did in the last
// hour and what it does next. Working is running work on the queue; work at
// `ready-to-merge` only waits on GitHub, so it does not count. A Floor with
// its hourly setting off, or with no Manager, gives none; a quiet Floor
// gives none either, so an idle office stays quiet.

export interface HourlyStatusUpdatesOptions {
  readonly floors: Pick<FloorStore, "list">;
  readonly work: Pick<WorkQueueStore, "active">;
  readonly statusUpdates: Pick<StatusUpdates, "give">;
  /** How often to give them; an hour. */
  readonly intervalMs?: number;
  /** Told when a Floor's could not be given, or a check failed. */
  readonly onError?: (error: unknown) => void;
}

export interface HourlyStatusUpdates {
  /** Gives each working Floor's Status update now; answers those given. */
  check(): Promise<StatusUpdate[]>;
  /** Checks every hour, until stopped. */
  start(): void;
  /** Stops checking, waiting for a check in progress. */
  stop(): Promise<void>;
}

/** An hour: how often a working Floor gives its Status update. */
export const hourlyStatusUpdateMs = 60 * 60 * 1000;

export function createHourlyStatusUpdates(
  options: HourlyStatusUpdatesOptions,
): HourlyStatusUpdates {
  const report = (error: unknown): void => {
    options.onError?.(error);
  };
  const intervalMs = options.intervalMs ?? hourlyStatusUpdateMs;

  const check = async (): Promise<StatusUpdate[]> => {
    const working = new Set(
      (await options.work.active())
        .filter(
          ({ status, stage }) =>
            status === "running" && stage !== "ready-to-merge",
        )
        .map(({ floorId }) => floorId),
    );
    const given: StatusUpdate[] = [];
    for (const floor of await options.floors.list()) {
      if (!floor.hourlyStatusUpdates || !working.has(floor.id)) {
        continue;
      }
      try {
        // None for a Floor with no Manager.
        const statusUpdate = await options.statusUpdates.give(
          floor.id,
          "hourly",
        );
        if (statusUpdate !== undefined) {
          given.push(statusUpdate);
        }
      } catch (error) {
        report(error);
      }
    }
    return given;
  };

  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<unknown> = Promise.resolve();

  const tick = (): void => {
    round = (async () => {
      await check().catch(report);
      if (running) {
        timer = setTimeout(tick, intervalMs);
      }
    })();
  };

  return {
    check,
    start() {
      if (running) {
        return;
      }
      running = true;
      timer = setTimeout(tick, intervalMs);
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await round;
    },
  };
}
