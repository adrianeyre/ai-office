import { useEffect, useState, type ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";

// A chat's reply while it is waited for (PRD FR-24): the Manager chat's, an
// Agent's direct chat's and the Terminal's. Until the first words arrive
// the Model is thinking: a spinner and "is thinking…" by the name, and
// three dots rising in turn in the bubble; then "is writing…" with the
// words so far and a cursor. After a few seconds it says how long it has
// waited, so a slow reply does not look stuck. The composer below says the
// same with `WaitingNote` and a bar sweeping along its box.

/** Seconds since the component first showed, counted each second. */
export function useElapsedSeconds(): number {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return Math.floor((now - started) / 1000);
}

/** "12s", "1m 05s": shown only once the wait is noticeable. */
export const waitedLabel = (seconds: number): string | undefined =>
  seconds < 3
    ? undefined
    : seconds < 60
      ? `${String(seconds)}s`
      : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, "0")}s`;

/** Three dots rising in turn: a reply is on its way. */
function TypingDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1 py-1.5">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          data-typing-dot=""
          style={{ animationDelay: `${String(delay)}ms` }}
          className="size-1.5 rounded-full bg-current"
        />
      ))}
    </span>
  );
}

export function PendingReply({
  name,
  text,
  terminal = false,
  children,
}: {
  /** Who is replying, as the chat names them. */
  name: string;
  /** The reply so far: empty while the Model thinks. */
  text: string;
  /** The Terminal's dark look. */
  terminal?: boolean;
  /** Under the bubble, such as the tools used so far. */
  children?: ReactNode;
}) {
  const waited = waitedLabel(useElapsedSeconds());
  const thinking = text === "";
  return (
    <div className="max-w-[85%] space-y-1">
      <p
        className={cn(
          "flex flex-wrap items-center gap-x-1.5 text-xs",
          terminal ? "text-zinc-400" : "text-muted-foreground",
        )}
      >
        {name}{" "}
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
            terminal
              ? "bg-zinc-800 text-zinc-100"
              : "bg-tone-info text-tone-info-foreground",
          )}
        >
          <Spinner className="size-3" />
          {thinking ? "is thinking…" : "is writing…"}
        </span>
        {waited !== undefined && (
          <span aria-hidden className="tabular-nums">
            {waited}
          </span>
        )}
      </p>
      <p
        className={cn(
          "inline-block rounded-lg px-3 py-2 break-words whitespace-pre-wrap ring-1",
          terminal
            ? "bg-zinc-800 ring-zinc-600"
            : "bg-muted ring-tone-info-foreground/25",
        )}
      >
        {thinking ? (
          <TypingDots />
        ) : (
          <>
            {text}
            <span aria-hidden className="animate-pulse">
              {" "}
              ▍
            </span>
          </>
        )}
      </p>
      {children}
    </div>
  );
}

/**
 * Over the message box while a reply is waited for: a bar sweeping along
 * its top edge. Its caller places it in a `relative` box.
 */
export function WaitingSweep({ active }: { active: boolean }) {
  if (!active) {
    return null;
  }
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-md"
    >
      <span
        data-waiting-sweep=""
        className="block h-full w-2/5 rounded-full bg-tone-info-foreground"
      />
    </span>
  );
}

/**
 * Under the message box: the chat's connection, or, while a reply is
 * waited for, who is answering, with a spinner, tinted so it is seen.
 */
export function WaitingNote({
  answering,
  live,
  children,
}: {
  answering: boolean;
  /** The chat's stream is open. */
  live: boolean;
  children: ReactNode;
}) {
  return (
    <p
      role="status"
      aria-label="Connection"
      className={cn(
        "flex w-fit items-center gap-1.5 text-xs",
        answering
          ? "rounded-full bg-tone-info px-2.5 py-1 font-medium text-tone-info-foreground"
          : "text-muted-foreground",
      )}
    >
      {(answering || !live) && <Spinner className="size-3" />}
      {children}
    </p>
  );
}
