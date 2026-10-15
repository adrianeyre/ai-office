import {
  managerChatFileListSchema,
  maxMentionSuggestions,
} from "@ai-office/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils.ts";

import { getJson } from "./api.ts";

// `@` file mentions in the Manager chat (PRD FR-24, ADR 0004), as Claude
// Code offers them: typing `@` starts a mention, and the repository's
// files matching what follows it are listed under the box, fetched a
// moment after the typing stops. The arrow keys move through them, Enter
// or Tab puts `@path ` in the box in place of the mention, and Escape
// closes the list. As with the Skills' autocomplete, the box stays a text
// box that names the list and the option chosen.

/** How long typing must stop before the files are fetched. */
export const mentionDebounceMs = 150;

/** The mention being written at `caret`: where its `@` is, and what follows. */
export function mentionAt(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | undefined {
  const match = /(?:^|[\s(])@([\w./-]*)$/.exec(text.slice(0, caret));
  if (match === null) {
    return undefined;
  }
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

/** `text` with the mention at `caret` replaced by `@path `, and the caret after it. */
export function withMention(
  text: string,
  caret: number,
  path: string,
): { readonly text: string; readonly caret: number } {
  const mention = mentionAt(text, caret);
  if (mention === undefined) {
    return { text, caret };
  }
  const inserted = `@${path} `;
  const after = text.slice(caret).replace(/^\S*\s?/, "");
  return {
    text: text.slice(0, mention.start) + inserted + after,
    caret: mention.start + inserted.length,
  };
}

function useDebounced<Value>(value: Value, ms: number): Value {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}

const filesQuery = (floorId: string, query: string) => ({
  queryKey: ["floors", floorId, "manager-chat-files", query],
  queryFn: async () =>
    (
      await getJson(
        `/api/floors/${encodeURIComponent(floorId)}/manager-chat/files?query=${encodeURIComponent(query)}`,
        managerChatFileListSchema,
      )
    ).files.slice(0, maxMentionSuggestions),
  staleTime: 30_000,
});

export interface FileMentionAutocomplete {
  readonly open: boolean;
  readonly inputProps: {
    readonly "aria-controls"?: string;
    readonly "aria-activedescendant"?: string;
  };
  /** Handles a key in the box; true when the list used it. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly list: ReactNode;
}

export function useFileMentions({
  floorId,
  text,
  caret,
  onChoose,
}: {
  floorId: string;
  text: string;
  /** Where the caret is in the box. */
  caret: number;
  /** Puts `text` in the box, with the caret at `caret`. */
  onChoose: (text: string, caret: number) => void;
}): FileMentionAutocomplete {
  const mention = mentionAt(text, caret);
  const query = useDebounced(mention?.query, mentionDebounceMs);
  const { data: files } = useQuery({
    ...filesQuery(floorId, query ?? ""),
    enabled: mention !== undefined && query !== undefined,
    placeholderData: keepPreviousData,
  });
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<string | undefined>();
  const [shownFor, setShownFor] = useState(text);
  const listId = useId();
  if (shownFor !== text) {
    setShownFor(text);
    setActive(0);
  }
  const matches = mention === undefined ? [] : (files ?? []);
  const open = matches.length > 0 && closedAt !== text;
  const current = Math.min(active, matches.length - 1);
  const optionId = (index: number) => `${listId}-${String(index)}`;
  const choose = (path: string | undefined) => {
    if (path !== undefined) {
      const next = withMention(text, caret, path);
      onChoose(next.text, next.caret);
    }
  };

  return {
    open,
    inputProps: open
      ? { "aria-controls": listId, "aria-activedescendant": optionId(current) }
      : {},
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
            aria-label="Files to mention"
            className="max-h-56 max-w-full space-y-0.5 overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          >
            {matches.map((path, index) => (
              <li
                key={path}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                className={cn(
                  "cursor-pointer rounded px-2 py-1 font-mono break-all",
                  index === current && "bg-accent text-accent-foreground",
                )}
                // Keeps focus in the box.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  choose(path);
                }}
              >
                {path}
              </li>
            ))}
          </ul>
        )}
        <p aria-live="polite" className="sr-only">
          {open
            ? `${String(matches.length)} ${matches.length === 1 ? "file matches" : "files match"}. Up and down choose one; Enter or Tab mentions it.`
            : ""}
        </p>
      </>
    ),
  };
}
