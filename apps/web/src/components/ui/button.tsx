import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

import { Spinner } from "./spinner.tsx";

// Every button is one height, 36 px, whatever its size: `sm` is only
// narrower, and `icon` is square. On a touch screen (a coarse pointer),
// every button is at least 44 px square, a fingertip's size (PRD §7:
// phones and tablets). Inputs and selects are 36 px too, so a row of them
// lines up.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate] duration-150 ease-out-quart outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 active:not-disabled:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  {
    variants: {
      variant: {
        // A soft top light and a tinted shadow: the one control that
        // should look pressable from across the page.
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(24_24_56/0.18)] hover:bg-primary/90 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_2px_6px_-1px_rgb(24_24_56/0.25)]",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/70",
        // A firmer border than a card's, so it reads as a control.
        outline:
          "border border-input/60 bg-card shadow-xs hover:border-input hover:bg-accent hover:text-accent-foreground dark:bg-card/60",
        ghost:
          "text-foreground/90 hover:bg-accent hover:text-accent-foreground",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-9 gap-1.5 px-3 has-[>svg]:px-2.5",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

// A pending button waits on the server: it shows the spinner in place of
// its icon, is busy and cannot be pressed again; its words say what it is
// doing, such as "Saving…".
function Button({
  className,
  variant,
  size,
  asChild = false,
  pending = false,
  disabled,
  children,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Waiting on what it started. */
    pending?: boolean;
  }) {
  if (asChild) {
    return (
      <Slot
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        {...(disabled !== undefined && { disabled })}
        {...props}
      >
        {children}
      </Slot>
    );
  }
  return (
    <button
      data-slot="button"
      className={cn(
        buttonVariants({ variant, size, className }),
        pending && "[&>svg:not([data-slot=spinner])]:hidden",
      )}
      disabled={disabled === true || pending}
      {...(pending && { "aria-busy": true, "data-pending": "" })}
      {...props}
    >
      {pending && <Spinner />}
      {children}
    </button>
  );
}

export { Button, buttonVariants };
