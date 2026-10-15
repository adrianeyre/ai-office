import type { EventBus, GrillingSessionChange } from "@ai-office/events";

import type { AgentStore } from "../agents/store.ts";
import { openInRound, type GrillingSessionRecord } from "./session.ts";
import type { GrillingStore } from "./store.ts";

// A Grilling Session's course on the event bus (PRD FR-83): each time the
// Manager chat keeps a session that started, paused, resumed, asked a
// round, settled answers or decisions within one, or ended, a
// `grilling.session_changed` event says so, with counts only. The Office
// projects it: the Manager walks to the meeting room and sits at the table
// while a session runs, and the whiteboard behind it follows the round and
// the decisions. Saves that change nothing of that (the facts found, the
// documents, the issues) publish nothing; those have events of their own.
// An event that cannot be published never fails the save: the session is
// kept, and the Office catches up the next time it changes.

/** What changed from `before` to `after`; undefined when nothing the Office shows did. */
export function sessionChange(
  before: GrillingSessionRecord | undefined,
  after: GrillingSessionRecord,
): GrillingSessionChange | undefined {
  if (before === undefined) {
    return after.status === "ended" ? "ended" : "started";
  }
  if (before.status !== after.status) {
    return { active: "resumed", paused: "paused", ended: "ended" }[
      after.status
    ] as GrillingSessionChange;
  }
  if (after.round > before.round) {
    return "round";
  }
  const answered = (session: GrillingSessionRecord) =>
    session.questions.filter(({ status }) => status !== "open").length;
  return answered(after) !== answered(before) ||
    after.decisions.length !== before.decisions.length
    ? "settled"
    : undefined;
}

export interface GrillingEventsOptions {
  readonly events: Pick<EventBus, "publish">;
  /** The Floor's Agents, to name its Manager, who runs its sessions. */
  readonly agents: Pick<AgentStore, "list">;
  /** Told when an event could not be published. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/** `store`, publishing each change to a session as it is kept. */
export function publishingGrillingStore(
  store: GrillingStore,
  { events, agents, onError }: GrillingEventsOptions,
): GrillingStore {
  const publish = async (
    before: GrillingSessionRecord | undefined,
    after: GrillingSessionRecord,
  ): Promise<void> => {
    const change = sessionChange(before, after);
    if (change === undefined) {
      return;
    }
    try {
      const manager = (await agents.list(after.floorId)).find(
        ({ role }) => role === "manager",
      );
      if (manager === undefined) {
        return;
      }
      await events.publish({
        type: "grilling.session_changed",
        version: 1,
        floorId: after.floorId,
        agentId: manager.id,
        sessionId: after.id,
        change,
        status: after.status,
        round: after.round,
        openQuestions: openInRound(after).length,
        decisions: after.decisions.length,
      });
    } catch (error) {
      onError?.(error);
    }
  };
  return {
    get: (floorId, id) => store.get(floorId, id),
    active: (floorId) => store.active(floorId),
    list: (floorId) => store.list(floorId),
    async create(session) {
      const created = await store.create(session);
      await publish(undefined, created);
      return created;
    },
    async save(session) {
      const before = await store.get(session.floorId, session.id);
      const saved = await store.save(session);
      await publish(before, saved);
      return saved;
    },
  };
}
