import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

// A short label in a pill: a status, a kind, a count. Each tone is a soft
// fill with dark ink in light mode and a deep one with light ink in dark,
// at 4.5:1 or more in both (styles.css's --tone-* tokens). A badge's
// meaning is in its words, never in its colour alone.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-current/15 ring-inset [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-tone-neutral text-tone-neutral-foreground",
        info: "bg-tone-info text-tone-info-foreground",
        success: "bg-tone-success text-tone-success-foreground",
        warning: "bg-tone-warning text-tone-warning-foreground",
        danger: "bg-tone-danger text-tone-danger-foreground",
        violet: "bg-tone-violet text-tone-violet-foreground",
        indigo: "bg-tone-indigo text-tone-indigo-foreground",
        primary: "bg-primary font-semibold text-primary-foreground",
        destructive: "bg-destructive font-semibold text-destructive-foreground",
        outline: "text-foreground ring-border",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants, type BadgeTone };
