import type { OfficeEvent } from "@ai-office/events/schema";
import type { StreamedEvent } from "@ai-office/events/stream";
import { describe, expect, it } from "vitest";

import {
  eventLines,
  keptLines,
  lineTokens,
  maxWrappedRows,
  monitorEventTypes,
  monitorScreens,
  screenColumns,
  type MonitorScreen,
} from "./monitor-preview.ts";

// What each desk's monitor shows (PRD FR-58): whether its Agent is
// working, and its activity as lines of "writing", from the Floor's events.

const sandbox = (agentId: string) =>
  ({
    version: 1,
    floorId: "web-shop",
    agentId,
    issue: 4,
    sandboxId: `sbx-${agentId}`,
  }) as const;

const stored = (id: number, event: OfficeEvent): StreamedEvent => ({
  id,
  occurredAt: new Date(Date.UTC(2026, 9, 9, 12, 0, id)).toISOString(),
  event,
});

const status = (
  id: number,
  agentId: string,
  value: "working" | "idle" | "blocked" | "capped" | "waiting",
) =>
  stored(id, {
    type: "agent.status_changed",
    version: 1,
    floorId: "web-shop",
    agentId,
    status: value,
    ...(value === "idle" ? {} : { issue: 4 }),
  });

const text = (id: number, agentId: string, words: string) =>
  stored(id, { type: "sandbox.text", ...sandbox(agentId), text: words });

const screenOf = (
  screens: ReadonlyMap<string, MonitorScreen>,
  agentId: string,
): MonitorScreen => {
  const screen = screens.get(agentId);
  if (screen === undefined) {
    throw new Error(`No monitor for ${agentId}.`);
  }
  return screen;
};

/** One line of text's length on a screen. */
const share = (characters: number) => characters / screenColumns;

describe("whether a monitor shows its Agent at work", () => {
  it("is off until its Agent works, and off again when it stops", () => {
    const agents = ["ada", "bo"];
    expect(screenOf(monitorScreens(agents, []), "ada")).toEqual({
      agentId: "ada",
      working: false,
      lines: [],
      activity: 0,
    });
    const working = monitorScreens(agents, [status(1, "ada", "working")]);
    expect(screenOf(working, "ada").working).toBe(true);
    expect(screenOf(working, "bo").working).toBe(false);
    for (const after of ["idle", "blocked", "capped", "waiting"] as const) {
      const stopped = monitorScreens(agents, [
        status(1, "ada", "working"),
        status(2, "ada", after),
      ]);
      expect(screenOf(stopped, "ada").working).toBe(false);
    }
  });

  it("is on once its sandbox starts, whatever the order the events came in", () => {
    const started = stored(3, {
      type: "sandbox.started",
      ...sandbox("ada"),
      branch: "ai-office/4-basket",
    });
    expect(screenOf(monitorScreens(["ada"], [started]), "ada").working).toBe(
      true,
    );
    // The latest event decides, by id, not by where it is in the list.
    expect(
      screenOf(
        monitorScreens(["ada"], [started, status(2, "ada", "idle")]),
        "ada",
      ).working,
    ).toBe(true);
    expect(
      screenOf(
        monitorScreens(["ada"], [status(4, "ada", "idle"), started]),
        "ada",
      ).working,
    ).toBe(false);
  });

  it("starts empty each time its Agent starts work, keeping its lines while it works", () => {
    const first = [
      status(1, "ada", "working"),
      text(2, "ada", "first task"),
      status(3, "ada", "idle"),
    ];
    expect(screenOf(monitorScreens(["ada"], first), "ada").lines).toHaveLength(
      1,
    );
    const second = monitorScreens(
      ["ada"],
      [...first, status(4, "ada", "working")],
    );
    expect(screenOf(second, "ada").lines).toEqual([]);
    // A second status of working, with no stop between, is the same work.
    const again = monitorScreens(
      ["ada"],
      [
        ...first,
        status(4, "ada", "working"),
        text(5, "ada", "x"),
        status(6, "ada", "working"),
      ],
    );
    expect(screenOf(again, "ada").lines).toHaveLength(1);
  });

  it("is each Agent's own, and leaves out the events of Agents not on the Floor", () => {
    const screens = monitorScreens(
      ["ada", "bo"],
      [
        status(1, "ada", "working"),
        status(2, "cy", "working"),
        text(3, "bo", "not working, but writing"),
        text(4, "cy", "gone"),
        stored(5, {
          type: "model_call.completed",
          version: 1,
          ownerTool: "local Claude Code",
          aiAccount: null,
          aiProvider: "Claude",
          model: "claude-opus-5-5",
          status: 200,
          latencyMs: 900,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        }),
      ],
    );
    expect([...screens.keys()]).toEqual(["ada", "bo"]);
    expect(screenOf(screens, "ada")).toMatchObject({ lines: [], activity: 0 });
    expect(screenOf(screens, "bo")).toMatchObject({
      working: false,
      activity: 3,
    });
  });

  it("reads each event once, however many times it is given", () => {
    const once = text(2, "ada", "once");
    const events = [status(1, "ada", "working"), once];
    const screens = monitorScreens(["ada"], [...events, ...events, once]);
    expect(screenOf(screens, "ada").lines).toHaveLength(1);
  });

  it("reads an Agent's statuses, its sandbox starting, and the activity the live view shows", () => {
    expect(monitorEventTypes).toEqual([
      "agent.status_changed",
      "sandbox.started",
      "sandbox.text",
      "sandbox.tool_call",
      "sandbox.diff",
      "model_call.completed",
    ]);
  });
});

describe("the lines on a monitor", () => {
  it("are a line of writing for each line of terminal output, as long and indented as it", () => {
    const lines = eventLines(
      text(7, "ada", "Running the tests.\n\n    12 passed\n\tdone\n"),
    );
    expect(
      lines.map(({ kind, token, indent, width }) => [
        kind,
        token,
        indent,
        width,
      ]),
    ).toEqual([
      ["text", "ink", 0, share(18)],
      // A blank line is a gap.
      ["text", "ink", 0, 0],
      ["text", "ink", share(4), share(9)],
      // A tab is four spaces.
      ["text", "ink", share(4), share(4)],
    ]);
  });

  it("wrap a long line onto a few rows, and draw a short one as a word", () => {
    const [first, second, third, ...rest] = eventLines(
      text(7, "ada", "x".repeat(screenColumns * 5)),
    );
    expect([first?.width, second?.width, third?.width]).toEqual([1, 1, 1]);
    expect(rest).toEqual([]);
    expect(maxWrappedRows).toBe(3);
    const wrapped = eventLines(text(8, "ada", "y".repeat(screenColumns + 6)));
    expect(wrapped.map(({ width }) => width)).toEqual([1, share(6)]);
    const [word] = eventLines(text(9, "ada", "a"));
    expect(word?.width).toBeGreaterThan(share(1));
  });

  it("are a line for a tool call, a header and a line each for a diff, and a line for a model call", () => {
    const tool = eventLines(
      stored(10, {
        type: "sandbox.tool_call",
        ...sandbox("ada"),
        name: "Bash",
        args: "pnpm test",
      }),
    );
    expect(tool.map(({ kind, width }) => [kind, width])).toEqual([
      ["tool", share("Bash pnpm test".length)],
    ]);

    const diff = eventLines(
      stored(11, {
        type: "sandbox.diff",
        ...sandbox("ada"),
        path: "src/basket.ts",
        diff: "-export const total = 0;\n+export const total = sum(items);\n@@\n context",
        added: 1,
        removed: 1,
      }),
    );
    expect(diff.map(({ kind, token }) => [kind, token])).toEqual([
      ["hunk", lineTokens.hunk],
      ["removed", "state-critical"],
      ["added", "state-ok"],
      ["hunk", lineTokens.hunk],
      ["text", "ink"],
    ]);

    const model = eventLines(
      stored(12, {
        type: "model_call.completed",
        version: 1,
        floorId: "web-shop",
        agentId: "ada",
        aiAccount: "Main",
        aiProvider: "Claude",
        model: "claude-opus-5-5",
        status: 200,
        latencyMs: 1200,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
    expect(model.map(({ kind, token }) => [kind, token])).toEqual([
      ["model", "state-neutral"],
    ]);

    expect(eventLines(status(13, "ada", "working"))).toEqual([]);
  });

  it("keep the latest lines, each numbered after the ones before", () => {
    const events = [
      status(1, "ada", "working"),
      ...Array.from({ length: 30 }, (_, index) =>
        text(index + 2, "ada", `line ${String(index)}`),
      ),
      text(40, "ada", Array.from({ length: 40 }, () => "z").join("\n")),
    ];
    const screen = screenOf(monitorScreens(["ada"], events), "ada");
    expect(screen.lines).toHaveLength(keptLines);
    expect(screen.activity).toBe(40);
    const seqs = screen.lines.map(({ seq }) => seq);
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // Every line of the long event comes after every line of an earlier one.
    const [earlier] = eventLines(text(39, "ada", "w"));
    expect(Math.min(...seqs)).toBeGreaterThan(earlier?.seq ?? Infinity);
  });
});
