import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils.ts";

export interface TabItem {
  /** Unique among the tabs. */
  readonly id: string;
  readonly label: ReactNode;
  readonly content: ReactNode;
}

/**
 * Tabs, as WAI-ARIA's tabs pattern has them: a tablist named `label`, the
 * arrow keys, Home and End moving between tabs, and only the chosen tab's
 * panel drawn. `selected` and `onSelect` make it controlled; otherwise it
 * starts on `initial`, or the first tab.
 */
export function Tabs({
  label,
  tabs,
  selected,
  initial,
  onSelect,
  className,
}: {
  label: string;
  tabs: readonly TabItem[];
  selected?: string | undefined;
  initial?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
  className?: string;
}) {
  const base = useId();
  const [own, setOwn] = useState(
    tabs.some(({ id }) => id === initial) ? initial : tabs[0]?.id,
  );
  const wanted = selected ?? own;
  // A tab that has gone (an Agent removed) gives way to the first.
  const current = tabs.find(({ id }) => id === wanted) ?? tabs[0];
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const choose = (id: string, focus = false) => {
    setOwn(id);
    onSelect?.(id);
    if (focus) {
      buttons.current.get(id)?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex(({ id }) => id === current?.id);
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined;
    const tab = next === undefined ? undefined : tabs[next];
    if (tab !== undefined) {
      event.preventDefault();
      choose(tab.id, true);
    }
  };

  if (current === undefined) {
    return null;
  }
  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = (id: string) => `${base}-panel-${id}`;
  return (
    <div className={cn("space-y-4", className)}>
      <div
        role="tablist"
        aria-label={label}
        className="flex flex-wrap gap-1 border-b"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const chosen = tab.id === current.id;
          return (
            <button
              key={tab.id}
              ref={(button) => {
                if (button === null) {
                  buttons.current.delete(tab.id);
                } else {
                  buttons.current.set(tab.id, button);
                }
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={chosen}
              aria-controls={panelId(tab.id)}
              tabIndex={chosen ? 0 : -1}
              className={cn(
                "-mb-px inline-flex items-center gap-2 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11",
                chosen
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                choose(tab.id);
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId(current.id)}
        aria-labelledby={tabId(current.id)}
        // The WAI-ARIA tabs pattern lets the panel take focus.
        tabIndex={0}
        className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-lg"
      >
        {current.content}
      </div>
    </div>
  );
}
