import type { ManagerChatToolUse } from "@ai-office/shared";

// The tools the Manager's session used for a reply, shown collapsed under
// it as Claude Code shows them (PRD FR-24, ADR 0004): "Used 3 tools",
// opening to each tool's name and what it was used on. While a reply is
// being written the same list grows as each `tool` frame arrives.

/** "Used 1 tool", "Used 3 tools"; "Using …" while the reply is written. */
export const toolUseLabel = (count: number, live: boolean): string =>
  `${live ? "Using" : "Used"} ${String(count)} ${count === 1 ? "tool" : "tools"}`;

export function ToolUses({
  tools,
  live = false,
}: {
  tools: readonly ManagerChatToolUse[];
  /** The reply is still being written. */
  live?: boolean;
}) {
  if (tools.length === 0) {
    return null;
  }
  return (
    <details className="text-xs text-muted-foreground" data-tools="">
      <summary className="cursor-pointer select-none">
        {toolUseLabel(tools.length, live)}
      </summary>
      <ol
        aria-label="Tools used"
        className="mt-1 space-y-0.5 border-l pl-3 font-mono"
      >
        {tools.map((tool, index) => (
          <li key={`${String(index)}-${tool.name}`} className="break-all">
            <span className="font-semibold text-foreground">{tool.name}</span>
            {tool.summary !== "" && <> {tool.summary}</>}
          </li>
        ))}
      </ol>
    </details>
  );
}
