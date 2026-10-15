import type { EventBus } from "@ai-office/events";

import type { Agents } from "../agents/agents.ts";
import type { BatchStore } from "../batches/store.ts";
import type { FloorStore } from "../floors/store.ts";

// Contractors leaving (PRD FR-10, ADR 0004). A Contractor is an Agent the
// Manager added for one Batch; once no running Batch needs it (its Batch
// has finished and held its Wrap-up), it leaves as any removed Agent does:
// at once when it is idle, or once the task it is in the middle of ends,
// taking no new work meanwhile. Its desk goes with it, and so does its
// one-off Role. A Contractor the Owner kept on the team is an ordinary
// Agent and never leaves on its own. Research Contractors leave as soon as
// they have reported back; one left over (AI Office stopped mid-research),
// or a work Contractor whose Batch was never made, leaves at the next
// sweep, once it is older than `graceMs`.

export interface ContractorDeparturesOptions {
  readonly agents: Pick<Agents, "list" | "release">;
  readonly floors: Pick<FloorStore, "list">;
  readonly batches: Pick<BatchStore, "get">;
  readonly events: EventBus;
  readonly now?: () => Date;
  /**
   * How long a Contractor with no Batch yet may stay: its Batch may still
   * be being made. An hour.
   */
  readonly graceMs?: number;
  /** Told of a Contractor that could not be let go. */
  readonly onError?: (error: unknown) => void;
}

export interface ContractorDepartures {
  /**
   * Lets go of every Contractor no running Batch needs, on one Floor or on
   * every Floor; answers their ids.
   */
  sweep(floorId?: string): Promise<string[]>;
  /** Sweeps now, and again whenever a Batch finishes; idempotent. */
  start(): void;
  stop(): void;
}

export function createContractorDepartures(
  options: ContractorDeparturesOptions,
): ContractorDepartures {
  const now = options.now ?? (() => new Date());
  const graceMs = options.graceMs ?? 60 * 60 * 1000;
  let unsubscribe: (() => void) | undefined;

  const sweep = async (floorId?: string): Promise<string[]> => {
    const floors =
      floorId === undefined
        ? (await options.floors.list({ includeArchived: true })).map(
            ({ id }) => id,
          )
        : [floorId];
    const gone: string[] = [];
    for (const floor of floors) {
      for (const agent of await options.agents.list(floor)) {
        const { contractor } = agent;
        if (contractor === null || agent.leavingAt !== null) {
          continue;
        }
        let needed: boolean;
        if (contractor.batchId === null) {
          needed = now().getTime() - agent.createdAt.getTime() < graceMs;
        } else {
          const batch = await options.batches.get(contractor.batchId);
          needed = batch !== undefined && batch.status !== "finished";
        }
        if (needed) {
          continue;
        }
        try {
          await options.agents.release(floor, agent.id);
          gone.push(agent.id);
        } catch (error) {
          options.onError?.(error);
        }
      }
    }
    return gone;
  };

  return {
    sweep,
    start() {
      if (unsubscribe !== undefined) {
        return;
      }
      void sweep().catch((error: unknown) => options.onError?.(error));
      unsubscribe = options.events.subscribe(
        ({ event }) => {
          if (event.type === "batch.finished") {
            void sweep(event.floorId).catch((error: unknown) =>
              options.onError?.(error),
            );
          }
        },
        { types: ["batch.finished"] },
      );
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
