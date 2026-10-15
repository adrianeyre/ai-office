import type { ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * A table's frame: a rounded border around it, with its rows' rules and
 * padding inside it, that scrolls sideways when the table is wider than the
 * screen, so the page itself never does. It can take focus, so the
 * keyboard can scroll it too (WCAG 2.1.1).
 */
export function TableFrame({
  label,
  className,
  children,
}: {
  /** What the scrolling region is called, such as "Roles, scrollable". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-slot="table-frame"
      className={cn(
        "relative w-full overflow-x-auto rounded-xl border bg-card shadow-xs",
        // The rows' padding against the frame, and no rule under the last row.
        "[&_:is(th,td):first-child]:pl-4 [&_:is(th,td):last-child]:pr-4 [&_tbody>tr:last-child]:border-b-0 [&_thead]:bg-muted/60",
        // Header cells as quiet labels, and the row under the pointer lit.
        "[&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:tracking-wide [&_thead_th]:text-muted-foreground [&_thead_th]:uppercase [&_tbody>tr]:transition-colors [&_tbody>tr:hover]:bg-muted/40",
        className,
      )}
    >
      {children}
    </div>
  );
}
