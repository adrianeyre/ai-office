import type { EventBus } from "@ai-office/events";
import { aiProviders, anyAiProvider } from "@ai-office/shared";

import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { FloorStore } from "../floors/store.ts";
import type { WorkItem } from "../work/store.ts";
import { agentsAtWork } from "./agents.ts";
import type { AgentRecord, AgentStore } from "./store.ts";

// Any AI Provider (FR-11): an Agent the Owner lets use whichever AI
// Provider is available is stored as `anyAiProvider`, and given a real one
// each time it is read for work. That is the AI Provider of the first
// usable AI Account, in priority order (ties to the oldest), whose AI
// Provider has a default Model; with none usable, the first held back
// (rate-limited) the same way; with no AI Account at all, the first AI
// Provider with a default Model. It then uses that AI Provider's default
// Model and effort, and keeps them for the rest of the task or session it
// starts. The flows, and the AI Gateway's Gateway Keys, read Agents
// through `workingAgentStore`; the Agent editor and the API read the
// stored choice.

/** An AI Account, as far as choosing an AI Provider goes. */
export interface AvailableAiAccount {
  readonly aiProvider: string;
  /** 1 is used first. */
  readonly priority: number;
  readonly paused: boolean;
  /** Until when the AI Gateway holds it back; null while it does not. */
  readonly limitedUntil: Date | null;
  readonly createdAt: Date;
}

/** What `anyAiProvider` is resolved against. */
export interface AiProviderAvailability {
  /** Each AI Provider's default Model (FR-15). */
  readonly defaults: DefaultModels;
  readonly accounts: readonly AvailableAiAccount[];
}

/**
 * The AI Provider an Agent on `aiProvider` uses now: `aiProvider` itself,
 * or for `anyAiProvider` the one `availability` offers first; undefined
 * when no AI Provider has a default Model.
 */
export function resolveAiProvider(
  aiProvider: string,
  availability: AiProviderAvailability,
  now: Date = new Date(),
): string | undefined {
  if (aiProvider !== anyAiProvider) {
    return aiProvider;
  }
  const { defaults, accounts } = availability;
  const withModel = accounts
    .filter(
      (account) => !account.paused && defaults[account.aiProvider] != null,
    )
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
  const usable = withModel.find(
    ({ limitedUntil }) =>
      limitedUntil === null || limitedUntil.getTime() <= now.getTime(),
  );
  return (
    (usable ?? withModel[0])?.aiProvider ??
    aiProviders.find((name) => defaults[name] != null)
  );
}

/**
 * `agent` as it works now: with `anyAiProvider`, on the AI Provider
 * `resolveAiProvider` chooses, with that one's default Model (as its own,
 * so it keeps it however long it is held) and default effort. Left as it
 * is when none can be chosen, so the flows say it has no Model.
 */
export function workingAgent(
  agent: AgentRecord,
  availability: AiProviderAvailability,
  now?: Date,
): AgentRecord {
  if (agent.aiProvider !== anyAiProvider) {
    return agent;
  }
  const aiProvider = resolveAiProvider(agent.aiProvider, availability, now);
  return aiProvider === undefined
    ? agent
    : {
        ...agent,
        aiProvider,
        modelOverride: availability.defaults[aiProvider] ?? null,
        effort: null,
      };
}
/** The AI Provider and Model an Agent on any AI Provider was given. */
interface Pin {
  readonly aiProvider: string;
  readonly modelOverride: string | null;
  /**
   * Whether it was given them in the middle of a task or session: then it
   * keeps them until that ends. Given them while idle, it is given them
   * afresh at its next read.
   */
  readonly atWork: boolean;
}

/** `workingAgentStore`, and how its pins are let go. */
export interface WorkingAgentStore extends AgentStore {
  /**
   * Lets go of the AI Provider an Agent was given: its next read gives it
   * one afresh, as at a Fresh Start.
   */
  release(agentId: string): void;
  /** Stops following the events. */
  stop(): void;
}

export interface WorkingAgentStoreOptions {
  readonly store: AgentStore;
  /** What is available now: read afresh whenever an Agent is given one. */
  readonly availability: () => Promise<AiProviderAvailability>;
  /** The work queue, whose running work puts its Agents at work. */
  readonly work?: {
    active(): Promise<
      readonly Pick<WorkItem, "floorId" | "status" | "agentId" | "stage">[]
    >;
  };
  /** The Floors, for their required reviewers (FR-27). */
  readonly floors?: Pick<FloorStore, "get">;
  /**
   * The events: an Agent with a session open (its Context Usage active)
   * is at work too, and a Fresh Start, a stopped sandbox, a change to the
   * Agent's config or its removal lets go of what it was given.
   */
  readonly events?: EventBus;
  readonly now?: () => Date;
}

/**
 * The Agents as the flows read them: each Agent on any AI Provider given a
 * real one (`workingAgent`). It is given one when it starts a task or a
 * session, and keeps it, with its Model, until that ends or a Fresh Start
 * begins, so its sandbox's agent tool, its Gateway Key and its Context
 * Usage agree throughout; its next task is given one afresh. While idle,
 * it is given one afresh at every read. Storing an Agent keeps its stored
 * AI Provider, Model and effort: the flows change other things (pausing
 * it, say), never those.
 */
export function workingAgentStore(
  options: WorkingAgentStoreOptions,
): WorkingAgentStore {
  const { store, availability, work, floors, events } = options;
  const now = options.now ?? (() => new Date());
  const pins = new Map<string, Pin>();
  /** Agents with a session open, by their Context Usage. */
  const sessions = new Set<string>();

  const unsubscribe =
    events?.subscribe(
      ({ event }) => {
        switch (event.type) {
          case "agent.context_usage":
            if (event.active) {
              sessions.add(event.agentId);
            } else {
              sessions.delete(event.agentId);
              pins.delete(event.agentId);
            }
            return;
          case "agent.fresh_start":
          case "sandbox.stopped":
          case "agent.removed":
            pins.delete(event.agentId);
            return;
          case "config.changed":
            if (event.agentId !== undefined) {
              pins.delete(event.agentId);
            }
            return;
          default:
            return;
        }
      },
      {
        types: [
          "agent.context_usage",
          "agent.fresh_start",
          "sandbox.stopped",
          "agent.removed",
          "config.changed",
        ],
      },
    ) ?? (() => undefined);

  /** The Agents on `floorId` in the middle of a task or a session. */
  const atWorkOn = async (floorId: string): Promise<Set<string>> => {
    const floor = await floors?.get(floorId);
    const busy =
      work === undefined
        ? new Set<string>()
        : agentsAtWork(
            floor ?? { id: floorId, requiredReviewerAgentIds: [] },
            await work.active(),
          );
    for (const agentId of sessions) {
      busy.add(agentId);
    }
    return busy;
  };

  return {
    ...store,
    async list(floorId) {
      const team = await store.list(floorId);
      if (!team.some(({ aiProvider }) => aiProvider === anyAiProvider)) {
        return team;
      }
      const busy = await atWorkOn(floorId);
      let available: AiProviderAvailability | undefined;
      const at = now();
      const working: AgentRecord[] = [];
      for (const agent of team) {
        if (agent.aiProvider !== anyAiProvider) {
          working.push(agent);
          continue;
        }
        const atWork = busy.has(agent.id);
        const pin = pins.get(agent.id);
        // Given one in this task or session, it keeps it.
        if (pin?.atWork === true && atWork) {
          working.push({
            ...agent,
            aiProvider: pin.aiProvider,
            modelOverride: pin.modelOverride,
            effort: null,
          });
          continue;
        }
        available ??= await availability();
        const given = workingAgent(agent, available, at);
        if (given.aiProvider === anyAiProvider) {
          pins.delete(agent.id);
        } else {
          pins.set(agent.id, {
            aiProvider: given.aiProvider,
            modelOverride: given.modelOverride,
            atWork,
          });
        }
        working.push(given);
      }
      return working;
    },
    async update(agent) {
      const stored = (await store.list(agent.floorId)).find(
        ({ id }) => id === agent.id,
      );
      return store.update(
        stored?.aiProvider === anyAiProvider
          ? {
              ...agent,
              aiProvider: stored.aiProvider,
              modelOverride: stored.modelOverride,
              effort: stored.effort,
            }
          : agent,
      );
    },
    release(agentId) {
      pins.delete(agentId);
    },
    stop: unsubscribe,
  };
}
