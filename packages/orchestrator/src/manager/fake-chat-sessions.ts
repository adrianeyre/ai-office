import type { ManagerChatToolUse } from "@ai-office/shared";

import type { CallingTool } from "../models/agent-tool-client.ts";
import type { SessionTool, SessionToolRun } from "./chat-sessions.ts";

// A fake agent tool for the Manager chat's sessions, for tests: each turn's
// answer and the tools it uses are scripted in order, every run is recorded
// as it was made, and the sessions it started are the ones it holds. Codex
// names its own sessions, as the real one does.

/** A scripted turn: its answer, and the tools used before it. */
export interface FakeSessionTurn {
  readonly text: string;
  readonly tools?: readonly ManagerChatToolUse[];
}

export interface FakeSessionTool extends SessionTool {
  /** Every run, as it was made. */
  readonly runs: SessionToolRun[];
  /** Queues the next turns' answers: a turn, or an error to throw. */
  answer(...turns: (FakeSessionTurn | string | Error)[]): void;
}

export function createFakeSessionTool(): FakeSessionTool {
  const runs: SessionToolRun[] = [];
  const turns: (FakeSessionTurn | string | Error)[] = [];
  const held = new Set<string>();
  let named = 0;
  const keyOf = (floorId: string, tool: CallingTool, id: string) =>
    `${floorId}\n${tool}\n${id}`;
  return {
    runs,
    answer(...next) {
      turns.push(...next);
    },
    holds: (floorId, tool, id) =>
      Promise.resolve(held.has(keyOf(floorId, tool, id))),
    async run(run) {
      runs.push(run);
      await Promise.resolve();
      const id = run.session.id ?? `codex-thread-${String((named += 1))}`;
      held.add(keyOf(run.floor.id, run.tool, id));
      run.onSession(id);
      const next = turns.shift();
      if (next === undefined) {
        throw new Error("No turn was scripted.");
      }
      if (next instanceof Error) {
        throw next;
      }
      const turn = typeof next === "string" ? { text: next } : next;
      for (const tool of turn.tools ?? []) {
        run.onTool(tool);
      }
      for (const word of turn.text.match(/\S+\s*/g) ?? []) {
        run.onText(word);
      }
      return { text: turn.text, stopReason: "end_turn" };
    },
  };
}
