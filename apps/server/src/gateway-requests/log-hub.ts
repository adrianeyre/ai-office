import type { GatewayLogLine } from "@ai-office/shared";

// The AI Gateway's log lines as they are written (PRD FR-44): the last
// few hundred are kept in memory for the live log stream, which replays
// them to a new viewer and then sends each new one. Lines arrive here
// already redacted by the logger.

export type LogListener = (line: GatewayLogLine) => void;

export interface LogHub {
  /** Takes one JSON log line, as the logger writes it. */
  write(line: string): void;
  /** The lines kept after `afterId`, oldest first. */
  recent(afterId?: number): GatewayLogLine[];
  /** Tells `listener` each line from now on. */
  subscribe(listener: LogListener): () => void;
}

const levels: Record<number, GatewayLogLine["level"]> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

// Fields every line has, shown on their own or not at all.
const omitted = new Set(["level", "time", "msg", "pid", "hostname"]);

export function createLogHub(
  options: {
    /** How many lines are kept; 500 by default. */
    readonly capacity?: number;
    /** Which lines are the Gateway's: by default, `component: "gateway"`. */
    readonly accept?: (fields: Record<string, unknown>) => boolean;
  } = {},
): LogHub {
  const capacity = options.capacity ?? 500;
  const accept =
    options.accept ?? ((fields) => fields["component"] === "gateway");
  const kept: GatewayLogLine[] = [];
  const listeners = new Set<LogListener>();
  let nextId = 1;

  return {
    write(text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }
      const fields = parsed as Record<string, unknown>;
      if (!accept(fields)) {
        return;
      }
      const line: GatewayLogLine = {
        id: nextId++,
        time: new Date(
          typeof fields["time"] === "number" ? fields["time"] : Date.now(),
        ).toISOString(),
        level: levels[Number(fields["level"])] ?? "info",
        message: typeof fields["msg"] === "string" ? fields["msg"] : "",
        fields: Object.fromEntries(
          Object.entries(fields).filter(([key]) => !omitted.has(key)),
        ),
      };
      kept.push(line);
      if (kept.length > capacity) {
        kept.shift();
      }
      for (const listener of [...listeners]) {
        listener(line);
      }
    },
    recent(afterId = 0) {
      return kept.filter(({ id }) => id > afterId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
