import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What the close button says to a screen reader, such as "Close cookie policy". */
  closeLabel: string;
  children: ReactNode;
  /** Controls kept in place under the body, which scrolls on its own. */
  footer?: ReactNode;
  className?: string;
}

/**
 * A modal dialog on the platform's own `<dialog>`: a title with a close
 * button, a body that scrolls on its own (both ways, when its content is
 * wider or taller than it), and an optional footer that stays in place.
 * It moves focus in and keeps it there, closes on Escape and on the
 * backdrop, and hands focus back to whatever opened it. Everything behind
 * it is inert while it is open.
 */
export function Dialog({
  open,
  onClose,
  title,
  closeLabel,
  children,
  footer,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnTo = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      returnTo.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      // Where showModal is missing (jsdom), the dialog still opens, just
      // not modally.
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
    if (!open && returnTo.current !== null) {
      returnTo.current.focus();
      returnTo.current = null;
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={cn(
        "m-auto max-h-[min(86dvh,56rem)] w-[min(45rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-[oklch(0.15_0.03_275/0.55)] backdrop:backdrop-blur-[3px] open:flex motion-safe:open:animate-[dialog-in_220ms_var(--ease-out-quart)]",
        className,
      )}
      // Escape: the platform's `cancel`, or the key itself where there is
      // no platform dialog.
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeRef.current();
        }
      }}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          closeRef.current();
        }
      }}
    >
      {open && (
        <>
          <div className="flex items-center gap-3 border-b px-6 py-4">
            <h2
              id={titleId}
              className="mr-auto text-lg leading-tight font-semibold tracking-tight"
            >
              {title}
            </h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label={closeLabel}
              data-autofocus
              onClick={onClose}
            >
              <X aria-hidden />
            </Button>
          </div>
          {/* Focusable, so the keyboard can scroll it (WCAG 2.1.1). */}
          <div
            role="region"
            aria-labelledby={titleId}
            tabIndex={0}
            data-testid="dialog-body"
            className="dialog-body min-h-0 flex-1 overflow-auto px-6 pt-4 pb-6 text-sm leading-relaxed"
          >
            {children}
          </div>
          {footer !== undefined && (
            <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-6 py-3">
              {footer}
            </div>
          )}
        </>
      )}
    </dialog>
  );
}
