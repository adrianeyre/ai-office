import type { EventType } from "@ai-office/events/schema";
import type { StreamedEvent } from "@ai-office/events/stream";
import type { PaletteToken } from "@ai-office/shared/palette";

// What each desk's monitor shows (PRD FR-58, §5 scenario 2): a stylised
// live preview of its Agent's activity. While the Agent works, its screen
// glows (`screen-glow`) and fills with lines of "writing", one for each
// line of its terminal output, each tool call and model call and each line
// of a diff, scrolling up as new ones come; otherwise it is off. The scene
// renders no text (PRD §7), so a line is only as long as what it stands
// for, coloured by what it is. The words are in the Agent live view, which
// the monitor's panel shows.

/** The events that say whether an Agent is working. */
export const monitorStatusEventTypes = [
  "agent.status_changed",
  "sandbox.started",
] as const satisfies readonly EventType[];

/** The events that write lines on an Agent's monitor. */
export const monitorActivityEventTypes = [
  "sandbox.text",
  "sandbox.tool_call",
  "sandbox.diff",
  "model_call.completed",
] as const satisfies readonly EventType[];

/** Every event a monitor shows. */
export const monitorEventTypes: readonly EventType[] = [
  ...monitorStatusEventTypes,
  ...monitorActivityEventTypes,
];

/** How many lines a screen shows at once. */
export const screenRows = 8;

/** How many characters one full line stands for. */
export const screenColumns = 48;

/**
 * How many lines each monitor keeps: a screen's worth, and as many again
 * that have just scrolled off the top, so they can be seen leaving.
 */
export const keptLines = 2 * screenRows;

/** The most rows one long line of output wraps onto. */
export const maxWrappedRows = 3;

/** What a line on a screen stands for. */
export type ScreenLineKind =
  "text" | "tool" | "added" | "removed" | "hunk" | "model";

/** The colour each kind of line is written in, on `screen-glow`. */
export const lineTokens: Readonly<Record<ScreenLineKind, PaletteToken>> = {
  text: "ink",
  tool: "state-info",
  added: "state-ok",
  removed: "state-critical",
  hunk: "state-neutral",
  model: "state-neutral",
};

export interface ScreenLine {
  /**
   * The line's place in its Agent's output, growing with each new line, so
   * the screen can tell which lines are new.
   */
  readonly seq: number;
  readonly kind: ScreenLineKind;
  readonly token: PaletteToken;
  /** Where it starts, as a share of the screen's writing width. */
  readonly indent: number;
  /** How long it is, as a share of the screen's writing width. */
  readonly width: number;
}

export interface MonitorScreen {
  readonly agentId: string;
  /** Whether the Agent is at work: its screen glows. */
  readonly working: boolean;
  /** Its latest `keptLines` lines, oldest first, since it last started work. */
  readonly lines: readonly ScreenLine[];
  /** The id of its latest event that wrote on the screen; 0 for none. */
  readonly activity: number;
}

/** Lines one event may write, so a seq is the event's id and the line's place in it. */
const linesPerEvent = 1024;

/** The shortest line drawn: it still reads as a word, not a dot. */
const shortest = 0.06;

/** The most a line is indented. */
const maxIndent = 0.5;

/** How long `characters` characters are on a screen, after `indent`. */
const widthOf = (characters: number, indent: number) =>
  Math.min(Math.max(characters / screenColumns, shortest), 1 - indent);

/**
 * One line of text as rows on a screen: indented as far as its leading
 * spaces (a tab is four), and wrapped onto at most `maxWrappedRows` rows.
 * A blank line is a gap.
 */
function textRows(
  line: string,
  kind: ScreenLineKind,
): Omit<ScreenLine, "seq">[] {
  const trimmed = line.trimEnd();
  const text = trimmed.trimStart();
  if (text === "") {
    return [{ kind, token: lineTokens[kind], indent: 0, width: 0 }];
  }
  const leading = trimmed.slice(0, trimmed.length - text.length);
  const spaces = leading.replaceAll("\t", "    ").length;
  const indent = Math.min(spaces / screenColumns, maxIndent);
  const perRow = Math.max(1, Math.round((1 - indent) * screenColumns));
  const rows: Omit<ScreenLine, "seq">[] = [];
  for (
    let start = 0;
    start < text.length && rows.length < maxWrappedRows;
    start += perRow
  ) {
    rows.push({
      kind,
      token: lineTokens[kind],
      indent,
      width: widthOf(Math.min(perRow, text.length - start), indent),
    });
  }
  return rows;
}

/** The kind of a line of a diff, by its first characters. */
const diffKind = (line: string): ScreenLineKind =>
  line.startsWith("@@")
    ? "hunk"
    : line.startsWith("+")
      ? "added"
      : line.startsWith("-")
        ? "removed"
        : "text";

/** The lines an event writes on its Agent's screen; none for one that writes nothing. */
export function eventLines({ id, event }: StreamedEvent): ScreenLine[] {
  let rows: Omit<ScreenLine, "seq">[];
  switch (event.type) {
    case "sandbox.text":
      rows = event.text
        .replace(/\n$/, "")
        .split("\n")
        .flatMap((line) => textRows(line, "text"));
      break;
    case "sandbox.tool_call":
      rows = textRows(`${event.name} ${event.args}`, "tool").slice(0, 1);
      break;
    case "sandbox.diff":
      rows = [
        ...textRows(event.path, "hunk").slice(0, 1),
        ...event.diff
          .split("\n")
          .flatMap((line) => textRows(line, diffKind(line)).slice(0, 1)),
      ];
      break;
    case "model_call.completed":
      // As long as the live view's summary of it: Model, tokens, latency.
      rows = [
        { kind: "model", token: lineTokens.model, indent: 0, width: 0.6 },
      ];
      break;
    default:
      return [];
  }
  // Only the last lines of a long event can be on the screen.
  return rows
    .slice(-keptLines)
    .map((row, index) => ({ ...row, seq: id * linesPerEvent + index }));
}

/** The id of the Agent an event is about, if it is one a monitor shows. */
function agentOf({ event }: StreamedEvent): string | undefined {
  switch (event.type) {
    case "agent.status_changed":
    case "sandbox.started":
    case "sandbox.text":
    case "sandbox.tool_call":
    case "sandbox.diff":
    case "model_call.completed":
      return event.agentId;
    default:
      return undefined;
  }
}

/**
 * Each Agent's monitor, from its Floor's events (in any order; each is
 * read once, in id order). An Agent is working from a status of `working`
 * or a sandbox starting until its next status; each time it starts work,
 * its screen starts empty.
 */
export function monitorScreens(
  agentIds: readonly string[],
  events: readonly StreamedEvent[],
): ReadonlyMap<string, MonitorScreen> {
  const screens = new Map<string, MonitorScreen>(
    agentIds.map((agentId) => [
      agentId,
      { agentId, working: false, lines: [], activity: 0 },
    ]),
  );
  const seen = new Set<number>();
  for (const stored of events.toSorted((a, b) => a.id - b.id)) {
    const agentId = agentOf(stored);
    const screen = agentId === undefined ? undefined : screens.get(agentId);
    if (screen === undefined || seen.has(stored.id)) {
      continue;
    }
    seen.add(stored.id);
    const { event } = stored;
    if (
      event.type === "agent.status_changed" ||
      event.type === "sandbox.started"
    ) {
      const working =
        event.type === "sandbox.started" || event.status === "working";
      screens.set(screen.agentId, {
        ...screen,
        working,
        lines: working && !screen.working ? [] : screen.lines,
      });
      continue;
    }
    const lines = eventLines(stored);
    if (lines.length > 0) {
      screens.set(screen.agentId, {
        ...screen,
        lines: [...screen.lines, ...lines].slice(-keptLines),
        activity: stored.id,
      });
    }
  }
  return screens;
}
