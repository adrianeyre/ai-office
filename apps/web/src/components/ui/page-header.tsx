import type { ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

export interface PageHeaderProps {
  /** The page's level-1 heading. */
  title: ReactNode;
  /** One or two sentences under the title, in muted ink. */
  description?: ReactNode;
  /** A line above the title: the way back, such as "Admin" or the Floor. */
  eyebrow?: ReactNode;
  /** The page's own controls, beside the title on a wide screen, under it on a phone. */
  actions?: ReactNode;
  /** Anything more under the description: a status, a gauge, an alert. */
  children?: ReactNode;
  className?: string;
}

/**
 * Every page's header, so every page opens alike: an optional way back, the
 * title, a description, and the page's actions to the right.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b pb-5",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-80 space-y-1.5">
        {eyebrow !== undefined && (
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase [&_a]:underline-offset-4 [&_a:hover]:text-foreground [&_a:hover]:underline">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance break-words md:text-[1.75rem] md:leading-tight">
          {title}
        </h1>
        {description !== undefined && (
          <p className="max-w-prose text-[0.9375rem] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        {children}
      </div>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
