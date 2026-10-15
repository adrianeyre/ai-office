import type { EventBus } from "@ai-office/events";
import type { GatewayKeyAuthenticator, GatewayKeys } from "@ai-office/gateway";
import type { OfficeStores } from "@ai-office/orchestrator";

// Each Agent has its own Gateway Key (ADR 0001, FR-46): one is made when
// the Agent is (`agent.created`), and revoked when it is removed
// (`agent.removed`). `catchUp` gives a key to every Agent without one,
// such as those made before Gateway Keys existed.

export interface AgentKeys {
  /** Gives every Agent on every Floor that has no key in use one. */
  catchUp(): Promise<void>;
  /** Stops following new and removed Agents. */
  stop(): void;
}

export function keepAgentKeys(options: {
  readonly events: EventBus;
  readonly keys: GatewayKeys;
  readonly stores: Pick<OfficeStores, "floors" | "agents">;
}): AgentKeys {
  const { events, keys, stores } = options;
  const unsubscribe = events.subscribe(
    async ({ event }) => {
      if (event.type === "agent.created") {
        await keys.ensureAgentKey({
          id: event.agentId,
          floorId: event.floorId,
          name: event.name,
        });
      } else if (event.type === "agent.removed") {
        await keys.revokeAgentKey(event.agentId);
      }
    },
    { types: ["agent.created", "agent.removed"] },
  );
  return {
    async catchUp() {
      for (const floor of await stores.floors.list({ includeArchived: true })) {
        for (const agent of await stores.agents.list(floor.id)) {
          await keys.ensureAgentKey(agent);
        }
      }
    },
    stop: unsubscribe,
  };
}

/**
 * The AI Gateway's Gateway Keys while their holders are at work
 * (pen-testing G1-4): an Agent's key calls models only while its Agent is
 * enabled (FR-11) and its Floor is in use (FR-9), so the Owner pausing the
 * Agent or archiving its Floor stops its key at once, as rotating it or
 * removing the Agent does. A key a sandbox held, or one taken from it, is
 * no use once its Agent's work is stopped. The Communications Agent's key
 * calls models only while it is not paused (FR-90). An Agent's caller
 * carries its AI Provider, read at each call, so a subscription serves it
 * only through that AI Provider's agent tool (FR-35; pen-testing G1-5).
 */
export function keysAtWork(options: {
  readonly keys: GatewayKeyAuthenticator;
  readonly stores: Pick<OfficeStores, "floors" | "agents">;
  /** Whether the Communications Agent is enabled; always, if not given. */
  readonly communicationsEnabled?: () => Promise<boolean>;
}): GatewayKeyAuthenticator {
  const { keys, stores, communicationsEnabled } = options;
  return {
    async authenticate(key) {
      const caller = await keys.authenticate(key);
      if (caller?.kind === "agent") {
        const [floor, team] = await Promise.all([
          stores.floors.get(caller.floorId),
          stores.agents.list(caller.floorId),
        ]);
        const agent = team.find(({ id }) => id === caller.agentId);
        // With its AI Provider as it is now: the Gateway serves its calls as
        // that AI Provider's agent tool only (pen-testing G1-5).
        return floor?.archivedAt === null && agent?.enabled === true
          ? { ...caller, aiProvider: agent.aiProvider }
          : undefined;
      }
      if (
        caller?.kind === "communications" &&
        communicationsEnabled !== undefined
      ) {
        return (await communicationsEnabled()) ? caller : undefined;
      }
      return caller;
    },
  };
}
