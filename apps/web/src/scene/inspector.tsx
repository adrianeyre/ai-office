import { ScanSearch } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

import type { Inspectable, InspectableObject } from "./inspectable.ts";
import { closeInspectable, openInspectable } from "./inspection.ts";
import { inspectorPanels } from "./inspector-panels.tsx";
import { panelClass } from "./lobby-panels.tsx";
import { MovablePanel } from "./movable-panel.tsx";
import { sameSelection, useSelectionStore } from "./selection-store.ts";

// The inspectable objects' HTML over the scene (PRD FR-58, §7): the list of
// every object where the lift is, which works from the keyboard as
// clicking in the scene does, and the panel an open object shows.

/** Highlight an object in the scene while it is focused or pointed at in the list. */
function highlight(object: Inspectable) {
  useSelectionStore.getState().hover({ kind: object.kind, id: object.id });
}

function unhighlight(object: Inspectable) {
  const { hovered, hover } = useSelectionStore.getState();
  if (sameSelection(hovered, object)) {
    hover(undefined);
  }
}

/** Arrow keys, Home and End move between the list's buttons. */
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  const buttons = [...event.currentTarget.querySelectorAll("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = {
    ArrowDown: at + 1,
    ArrowUp: at - 1,
    Home: 0,
    End: buttons.length - 1,
  }[event.key];
  if (next === undefined) {
    return;
  }
  event.preventDefault();
  buttons[(next + buttons.length) % buttons.length]?.focus();
}

/**
 * Every object that can be inspected where the lift is. Picking one opens
 * its panel and flies the camera in, as clicking it in the scene does.
 */
export function InspectablesList({
  objects,
}: {
  objects: readonly InspectableObject[];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const selected = useSelectionStore((state) => state.selected);
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        size="sm"
        variant="outline"
        className="pointer-events-auto"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <ScanSearch aria-hidden />
        Inspect
      </Button>
      <nav
        id={id}
        aria-label="Objects to inspect"
        hidden={!open}
        className={cn(panelClass, "w-64")}
      >
        <ul
          className="max-h-72 space-y-1 overflow-y-auto"
          onKeyDown={moveFocus}
        >
          {objects.map((object) => {
            const current = sameSelection(selected, object);
            return (
              <li key={`${object.kind}:${object.id}`}>
                <Button
                  size="sm"
                  variant={current ? "secondary" : "ghost"}
                  className="w-full justify-start"
                  aria-haspopup="dialog"
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    openInspectable(object);
                  }}
                  onFocus={() => {
                    highlight(object);
                  }}
                  onBlur={() => {
                    unhighlight(object);
                  }}
                  onMouseEnter={() => {
                    highlight(object);
                  }}
                  onMouseLeave={() => {
                    unhighlight(object);
                  }}
                >
                  <span className="truncate">{object.label}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/**
 * The open object's panel, over the scene beside it: its type's own panel
 * (inspector-panels.tsx), in a panel the Owner can move, resize and fill
 * the screen with (movable-panel.tsx). Escape closes it too (the Office
 * view listens for it).
 */
export function InspectorPanel({
  object,
  navigate,
}: {
  object: InspectableObject;
  navigate?: ((href: string) => void) | undefined;
}) {
  const Body = inspectorPanels[object.kind];
  return (
    <MovablePanel
      layoutKey={object.kind}
      title={object.label}
      onClose={closeInspectable}
      // The session chat takes a little more room for its question cards.
      widthClass={object.kind === "grilling-session" ? "w-96" : "w-80"}
    >
      <Body object={object} navigate={navigate} />
    </MovablePanel>
  );
}
