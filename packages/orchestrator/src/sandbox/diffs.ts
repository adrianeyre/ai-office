// File diffs from Claude Code's stream (PRD FR-58: the monitor shows the
// Agent's diffs). Each `Edit`, `MultiEdit` and `Write` tool call carries
// what it changes, so the diff is known as the Agent makes the change,
// before anything is committed.

/** One file the Agent changed, as `-` and `+` lines. */
export interface FileDiff {
  readonly path: string;
  readonly diff: string;
  readonly added: number;
  readonly removed: number;
}

const lines = (text: string): string[] =>
  text === "" ? [] : text.replace(/\n$/, "").split("\n");

const isString = (value: unknown): value is string => typeof value === "string";

/** The `-` and `+` lines replacing `before` with `after`. */
const change = (before: string, after: string) => {
  const removed = lines(before);
  const added = lines(after);
  return {
    text: [
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
    ].join("\n"),
    added: added.length,
    removed: removed.length,
  };
};

/** The diff of one tool call, if it is one that changes a file. */
function toolDiff(name: unknown, input: unknown): FileDiff | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const fields = input as Record<string, unknown>;
  const path = fields["file_path"];
  if (!isString(path) || path === "") {
    return undefined;
  }
  let changes: { text: string; added: number; removed: number }[];
  if (name === "Write" && isString(fields["content"])) {
    changes = [change("", fields["content"])];
  } else if (
    name === "Edit" &&
    isString(fields["old_string"]) &&
    isString(fields["new_string"])
  ) {
    changes = [change(fields["old_string"], fields["new_string"])];
  } else if (name === "MultiEdit" && Array.isArray(fields["edits"])) {
    changes = (fields["edits"] as unknown[]).flatMap((edit) => {
      const { old_string: before, new_string: after } = (edit ?? {}) as Record<
        string,
        unknown
      >;
      return isString(before) && isString(after) ? [change(before, after)] : [];
    });
  } else {
    return undefined;
  }
  return {
    path,
    diff: changes.map(({ text }) => text).join("\n@@\n"),
    added: changes.reduce((sum, { added }) => sum + added, 0),
    removed: changes.reduce((sum, { removed }) => sum + removed, 0),
  };
}

/** Every file a line of Claude Code's stream-json output changes. */
export function fileDiffs(line: string): FileDiff[] {
  if (!line.startsWith("{")) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const { type, message } = (parsed ?? {}) as {
    type?: unknown;
    message?: { content?: unknown };
  };
  if (type !== "assistant" || !Array.isArray(message?.content)) {
    return [];
  }
  return (message.content as unknown[]).flatMap((block) => {
    const {
      type: blockType,
      name,
      input,
    } = (block ?? {}) as Record<string, unknown>;
    const diff = blockType === "tool_use" ? toolDiff(name, input) : undefined;
    return diff === undefined ? [] : [diff];
  });
}
