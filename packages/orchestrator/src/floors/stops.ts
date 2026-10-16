import { floorStops, type Database } from "@ai-office/db";
import type { EventBus } from "@ai-office/events";
import { eq } from "drizzle-orm";

import type { WorkQueue } from "../work/queue.ts";
import type { WorkQueueStore } from "../work/store.ts";

// "Stop everything" from the Meeting Room: the Owner stops a whole Floor.
// Its running work is interrupted and goes back in the queue for the same
// Agent, as the watchdog's retry does, and no work starts there until the
// Owner continues; then each piece starts again from its issue's label
// and branch. Stops live in `floor_stops`, so one outlasts a restart.
// A Floor removed has its work ended for good: none of it starts again.

/** A Floor the Owner stopped, and when. */
export interface FloorStop {
  readonly floorId: string;
  readonly stoppedAt: Date;
}

export interface FloorStopStore {
  list(): Promise<FloorStop[]>;
  put(stop: FloorStop): Promise<void>;
  /** Nothing if the Floor is not stopped. */
  remove(floorId: string): Promise<void>;
}

/** Keeps stops in memory: for tests. */
export function memoryFloorStopStore(): FloorStopStore & {
  readonly stops: Map<string, FloorStop>;
} {
  const stops = new Map<string, FloorStop>();
  return {
    stops,
    list: () => Promise.resolve([...stops.values()].map((s) => ({ ...s }))),
    put(stop) {
      stops.set(stop.floorId, { ...stop });
      return Promise.resolve();
    },
    remove(floorId) {
      stops.delete(floorId);
      return Promise.resolve();
    },
  };
}

/** Keeps stops in `floor_stops`. */
export function databaseFloorStopStore(db: Database): FloorStopStore {
  return {
    list: () => db.select().from(floorStops),
    async put(stop) {
      await db
        .insert(floorStops)
        .values(stop)
        .onConflictDoNothing({ target: floorStops.floorId });
    },
    async remove(floorId) {
      await db.delete(floorStops).where(eq(floorStops.floorId, floorId));
    },
  };
}

export interface FloorStops {
  /** Reads the stops kept, as the server starts. */
  start(): Promise<void>;
  /** The Floors stopped now, for the work queue to hold. */
  stopped(): readonly string[];
  /** When the Floor was stopped; undefined while it works. */
  stoppedAt(floorId: string): Date | undefined;
  /**
   * Stops everything on the Floor: running work goes back in the queue,
   * and none starts until it continues. Resolves once the running work
   * has ended. Stopping a stopped Floor changes nothing.
   */
  stop(floorId: string): Promise<void>;
  /** Lets the Floor's Agents carry on with their work. */
  carryOn(floorId: string): Promise<void>;
  /**
   * Ends all the work of a Floor removed: its running work is interrupted
   * and cancelled, its sandboxes stopped, and the work queued for it is
   * cancelled, none of it to start again. Resolves once the running work
   * has ended.
   */
  end(floorId: string): Promise<void>;
}

export interface FloorStopsOptions {
  readonly store: FloorStopStore;
  readonly events: EventBus;
  /** The work running and queued, to find the Floor's. */
  readonly work: Pick<WorkQueueStore, "active" | "end">;
  /** The work queue, made after the stops it reads. */
  readonly queue: () => Pick<WorkQueue, "interrupt" | "wake">;
  readonly now?: () => Date;
}

export function createFloorStops(options: FloorStopsOptions): FloorStops {
  const { store, events } = options;
  const now = options.now ?? (() => new Date());
  const stops = new Map<string, Date>();
  return {
    async start() {
      for (const { floorId, stoppedAt } of await store.list()) {
        stops.set(floorId, stoppedAt);
      }
    },
    stopped: () => [...stops.keys()],
    stoppedAt: (floorId) => stops.get(floorId),
    async stop(floorId) {
      if (stops.has(floorId)) {
        return;
      }
      const stoppedAt = now();
      await store.put({ floorId, stoppedAt });
      // Held first, so nothing interrupted starts again at once.
      stops.set(floorId, stoppedAt);
      const running = (await options.work.active()).filter(
        (item) => item.floorId === floorId && item.status === "running",
      );
      await Promise.all(
        running.map((item) =>
          options.queue().interrupt(item.id, { requeue: true }),
        ),
      );
      await events.publish({ type: "floor.stopped", version: 1, floorId });
    },
    async carryOn(floorId) {
      if (!stops.has(floorId)) {
        return;
      }
      await store.remove(floorId);
      stops.delete(floorId);
      await events.publish({ type: "floor.continued", version: 1, floorId });
      options.queue().wake();
    },
    async end(floorId) {
      const items = (await options.work.active()).filter(
        (item) => item.floorId === floorId,
      );
      await Promise.all(
        items.map(async (item) => {
          if (item.status === "queued") {
            // None is claimed meanwhile: no work starts on a Floor removed.
            await options.work.end(item.id, "cancelled", now());
          } else {
            await options.queue().interrupt(item.id);
          }
        }),
      );
      // A Floor removed is not stopped any more: it is gone.
      if (stops.delete(floorId)) {
        await store.remove(floorId);
      }
    },
  };
}
