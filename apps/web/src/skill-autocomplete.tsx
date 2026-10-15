import type { FloorSkill } from "@ai-office/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

import { floorSkillsQuery } from "./floor-skills-card.tsx";

// Autocomplete for `/skill-name` in the Manager chat (PRD FR-24, FR-74):
// while the box holds only a `/` and the start of a name, the Floor's
// Skills that match are listed under it. The arrow keys move through them,
// Enter or Tab puts `/name ` in the box, and Escape closes the list; so
// does a click on one. The box stays a text box, which names the list
// (`aria-controls`) and the option chosen (`aria-activedescendant`).

/** The most Skills listed at once. */
const maxShown = 8;

/** The Skills matching `/query`: those it starts first, then those holding it. */
export function matchingSkills(
  skills: readonly FloorSkill[],
  text: string,
): FloorSkill[] {
  const query = /^\/([a-z0-9-]*)$/.exec(text.trimStart())?.[1];
  if (query === undefined) {
    return [];
  }
  const starting = skills.filter(({ name }) => name.startsWith(query));
  const holding = skills.filter(
    ({ name }) => !name.startsWith(query) && name.includes(query),
  );
  return [...starting, ...holding].slice(0, maxShown);
}

export interface SkillAutocomplete {
  /** For the box: what it controls, and the option chosen. */
  readonly inputProps: {
    readonly "aria-autocomplete": "list";
    readonly "aria-controls"?: string;
    readonly "aria-activedescendant"?: string;
  };
  /** Handles a key in the box; true when the list used it. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The list, when it is open, and what it says to a screen reader. */
  readonly list: ReactNode;
}

export function useSkillAutocomplete({
  floorId,
  text,
  onChoose,
}: {
  floorId: string;
  text: string;
  /** Puts `/name ` in the box. */
  onChoose: (text: string) => void;
}): SkillAutocomplete {
  const { data } = useQuery(floorSkillsQuery(floorId));
  const [active, setActive] = useState(0);
  // The text the Owner closed the list at; it opens again once that changes.
  const [closedAt, setClosedAt] = useState<string | undefined>();
  const [shownFor, setShownFor] = useState(text);
  const listId = useId();
  if (shownFor !== text) {
    setShownFor(text);
    setActive(0);
  }
  const matches = matchingSkills(data?.skills ?? [], text);
  const open = matches.length > 0 && closedAt !== text;
  const current = Math.min(active, matches.length - 1);
  const optionId = (index: number) => `${listId}-${String(index)}`;
  const choose = (skill: FloorSkill | undefined) => {
    if (skill !== undefined) {
      onChoose(`/${skill.name} `);
    }
  };

  return {
    inputProps: {
      "aria-autocomplete": "list",
      ...(open
        ? {
            "aria-controls": listId,
            "aria-activedescendant": optionId(current),
          }
        : {}),
    },
    onKeyDown(event) {
      if (!open) {
        return false;
      }
      switch (event.key) {
        case "ArrowDown":
          setActive((current + 1) % matches.length);
          return true;
        case "ArrowUp":
          setActive((current - 1 + matches.length) % matches.length);
          return true;
        case "Enter":
        case "Tab":
          if (event.shiftKey) {
            return false;
          }
          choose(matches[current]);
          return true;
        case "Escape":
          setClosedAt(text);
          return true;
        default:
          return false;
      }
    },
    list: (
      <>
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Skills to run"
            className="max-h-56 max-w-full space-y-0.5 overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          >
            {matches.map((skill, index) => (
              <li
                key={skill.name}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                className={cn(
                  "cursor-pointer rounded px-2 py-1 break-words",
                  index === current && "bg-accent text-accent-foreground",
                )}
                // Keeps focus in the box.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  choose(skill);
                }}
              >
                <span className="font-mono break-all">/{skill.name}</span>{" "}
                <span
                  className={cn(
                    "text-xs",
                    // The theme's accent is too deep for muted ink in dark mode.
                    index === current
                      ? "text-accent-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {skill.description}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p aria-live="polite" className="sr-only">
          {open
            ? `${String(matches.length)} ${matches.length === 1 ? "Skill matches" : "Skills match"}. Up and down choose one; Enter or Tab puts it in the box.`
            : ""}
        </p>
      </>
    ),
  };
}
