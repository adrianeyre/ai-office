import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

// The one loading indicator: whatever is waiting on the server shows it,
// beside words that say what it is waiting for, so it is decorative and
// hidden from screen readers. Under reduced motion it stands still (the
// stylesheet stops every animation); the words still say it is waiting.

function Spinner({ className, ...props }: ComponentProps<typeof LoaderCircle>) {
  return (
    <LoaderCircle
      aria-hidden
      data-slot="spinner"
      className={cn("size-4 shrink-0 animate-spin", className)}
      {...props}
    />
  );
}

/** A spinner and what is being waited for, such as "Loading the Floor…". */
function LoadingMessage({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      data-slot="loading"
      className={cn("flex items-center gap-2 text-muted-foreground", className)}
    >
      <Spinner className="size-3.5" />
      <span>{children}</span>
    </p>
  );
}

export { LoadingMessage, Spinner };
