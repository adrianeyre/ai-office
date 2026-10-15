import type { EventBus } from "@ai-office/events";
import {
  contextUsageOf,
  directChatSession,
  contextUsagePercent,
  type AgentContextUsage,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";

// Context Usage (PRD FR-84, FR-85): how full an Agent's working context is.
// Every model call through the AI Gateway is told here as it is recorded;
// its input tokens (cached ones included: the whole prompt) are kept
// against the calling Agent's current session, and divided by its Model's
// context window from the model catalogue. A sandbox's run is one session
// (the session its agent tool names in `x-ai-office-session`); the Manager
// chat's calls name none, and are one session for as long as it lasts.
//
// - Reviewer calls are stateless (each review starts afresh), so they have
//   no Context Usage and are left out.
// - Only the Manager works outside a sandbox: an Agent's call that names no
//   session (its Kickoff acknowledgement of a Plan, say) is a one-off, as
//   stateless as a review, and changes nothing. Its working context is its
//   sandbox's session.
// - The Owner's direct chat with an Agent is its own conversation, apart
//   from the Agent's working context: its calls (session `direct-chat`)
//   change nothing here, and the chat measures its own.
// - The Communications Agent belongs to no Floor and has no session: its
//   Digests and reports are left out.
// - Calls to another Model than the Agent's are side calls (an agent tool's
//   small model, say), not its working context, so they change nothing.
// - A call that started before the one already counted is late, and a call
//   in a session that has ended is left over: neither changes anything.
// - A Model the catalogue gives no context window has an unknown Context
//   Usage (null), never 0%.
//
// An `agent.context_usage` event is published when an Agent's whole
// percentage (or whether it is known) changes, and when its session ends.
// It is kept in memory: a restart ends every sandbox, and with them their
// sessions.

/** A model call through the AI Gateway, as its request history records it. */
export interface ObservedModelCall {
  readonly agentId: string | null;
  readonly floorId: string | null;
  /** The session its caller named; null when it named none. */
  readonly session?: string | null | undefined;
  readonly issue: number | null;
  /** Which of the Gateway's endpoints it came to, such as `messages`. */
  readonly endpoint: string;
  readonly model: string | null;
  readonly status: number;
  readonly startedAt: Date;
  readonly inputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
}

/** One Agent's Context Usage in its current session. */
export interface ContextUsageState {
  readonly agentId: string;
  readonly floorId: string;
  readonly session: string | null;
  readonly issue: number | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly contextWindow: number | null;
  /** From 0 to 1; null when the context window is unknown. */
  readonly contextUsage: number | null;
  /** When the call it is from started. */
  readonly callStartedAt: Date;
  readonly updatedAt: Date;
}

export type ContextUsageListener = (state: ContextUsageState) => void;

export interface ContextUsage {
  /** Counts a model call, once the Gateway has recorded it. */
  observe(call: ObservedModelCall): Promise<void>;
  /**
   * Ends an Agent's session: its Context Usage is gone until its next
   * session's first call, and calls still arriving for it change nothing.
   */
  endSession(agentId: string, session: string | null): Promise<void>;
  /** Forgets an Agent, such as one removed from its Floor. */
  forget(agentId: string): Promise<void>;
  /** An Agent's Context Usage, while it has a session going. */
  of(agentId: string): ContextUsageState | undefined;
  /** The Floor's Agents with a session going. */
  onFloor(floorId: string): ContextUsageState[];
  /** Tells `listener` of every change to any Agent's Context Usage. */
  subscribe(listener: ContextUsageListener): () => void;
}

export interface ContextUsageOptions {
  readonly events: EventBus;
  readonly agents: AgentStore;
  /** Each AI Provider's default Model, for Agents without their own. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  /** A Model's context window from the model catalogue; null if unknown. */
  readonly contextWindow: (
    aiProvider: string,
    model: string,
  ) => Promise<number | null>;
  readonly now?: () => Date;
  /** Told when a listener throws; the others still hear of the change. */
  readonly onError?: (error: unknown) => void;
}

/** The Gateway's endpoints whose calls are an Agent's working context. */
const conversationEndpoints: ReadonlySet<string> = new Set([
  "messages",
  "chat_completions",
  "responses",
]);

/** How many ended sessions are remembered per Agent. */
const endedKept = 20;

/** The whole prompt of a call: its input tokens, cached ones included. */
export const callInputTokens = (
  call: Pick<
    ObservedModelCall,
    "inputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens"
  >,
): number | null =>
  call.inputTokens === null
    ? null
    : call.inputTokens +
      (call.cacheReadInputTokens ?? 0) +
      (call.cacheCreationInputTokens ?? 0);

/** A state as `GET /api/floors/:floorId/context-usage` sends it. */
export const contextUsageBody = (
  state: ContextUsageState,
): AgentContextUsage => ({
  agentId: state.agentId,
  floorId: state.floorId,
  issue: state.issue,
  model: state.model,
  inputTokens: state.inputTokens,
  contextWindow: state.contextWindow,
  contextUsage: state.contextUsage,
  updatedAt: state.updatedAt.toISOString(),
});

/** What an event says of a Context Usage: its whole percent, or unknown. */
const shown = (usage: number | null): number | null =>
  usage === null ? null : contextUsagePercent(usage);

export function createContextUsage(options: ContextUsageOptions): ContextUsage {
  const { events, agents } = options;
  const now = options.now ?? (() => new Date());
  const states = new Map<string, ContextUsageState>();
  const ended = new Map<string, (string | null)[]>();
  const listeners = new Set<ContextUsageListener>();

  // One change at a time, in the order they were told.
  let previous: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = previous.then(work);
    previous = next.catch(() => undefined);
    return next;
  };

  const tell = (state: ContextUsageState): void => {
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const hasEnded = (agentId: string, session: string | null): boolean =>
    ended.get(agentId)?.includes(session) ?? false;

  /** The Agent's Role and Model, if it is on the Floor. */
  const agentOf = async (floorId: string, agentId: string) => {
    const agent = (await agents.list(floorId)).find(({ id }) => id === agentId);
    if (agent === undefined) {
      return undefined;
    }
    const model = modelOf(agent, await options.defaultModels?.());
    return model === undefined ? undefined : { ...agent, model };
  };

  return {
    observe(call) {
      const { agentId, floorId } = call;
      const tokens = callInputTokens(call);
      if (
        agentId === null ||
        floorId === null ||
        tokens === null ||
        call.model === null ||
        call.status < 200 ||
        call.status >= 300 ||
        !conversationEndpoints.has(call.endpoint)
      ) {
        return Promise.resolve();
      }
      const session = call.session ?? null;
      if (session === directChatSession) {
        return Promise.resolve();
      }
      return serial(async () => {
        if (hasEnded(agentId, session)) {
          return;
        }
        const current = states.get(agentId);
        if (
          current?.session === session &&
          call.startedAt < current.callStartedAt
        ) {
          return;
        }
        const agent = await agentOf(floorId, agentId);
        if (
          agent === undefined ||
          agent.stage === "review" ||
          (session === null && agent.role !== "manager") ||
          agent.model !== call.model
        ) {
          return;
        }
        const contextWindow = await options.contextWindow(
          agent.aiProvider,
          agent.model,
        );
        const state: ContextUsageState = {
          agentId,
          floorId,
          session,
          issue: call.issue,
          model: agent.model,
          inputTokens: tokens,
          contextWindow,
          contextUsage: contextUsageOf(tokens, contextWindow),
          callStartedAt: call.startedAt,
          updatedAt: now(),
        };
        states.set(agentId, state);
        const changed =
          current?.session !== session ||
          shown(current.contextUsage) !== shown(state.contextUsage);
        if (changed) {
          await events.publish({
            type: "agent.context_usage",
            version: 1,
            floorId,
            agentId,
            ...(state.issue === null ? {} : { issue: state.issue }),
            active: true,
            model: state.model,
            inputTokens: state.inputTokens,
            contextWindow: state.contextWindow,
            contextUsage: state.contextUsage,
          });
        }
        tell(state);
      });
    },

    endSession(agentId, session) {
      return serial(async () => {
        ended.set(agentId, [
          ...(ended.get(agentId) ?? []).slice(1 - endedKept),
          session,
        ]);
        const current = states.get(agentId);
        if (current?.session !== session) {
          return;
        }
        states.delete(agentId);
        await events.publish({
          type: "agent.context_usage",
          version: 1,
          floorId: current.floorId,
          agentId,
          ...(current.issue === null ? {} : { issue: current.issue }),
          active: false,
          contextUsage: null,
        });
      });
    },

    forget(agentId) {
      return serial(() => {
        states.delete(agentId);
        ended.delete(agentId);
        return Promise.resolve();
      });
    },

    of: (agentId) => states.get(agentId),

    onFloor: (floorId) =>
      [...states.values()]
        .filter((state) => state.floorId === floorId)
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Ends each sandbox's session as the sandbox stops (a run is one session),
 * and forgets each Agent removed from its Floor.
 */
export function followSandboxSessions(
  events: EventBus,
  usage: ContextUsage,
): () => void {
  return events.subscribe(
    ({ event }) => {
      if (event.type === "sandbox.stopped") {
        return usage.endSession(event.agentId, event.sandboxId);
      }
      if (event.type === "agent.removed") {
        return usage.forget(event.agentId);
      }
      return undefined;
    },
    { types: ["sandbox.stopped", "agent.removed"] },
  );
}
