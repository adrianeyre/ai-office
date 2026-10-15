import {
  managerChatTaskListSchema,
  managerChatTaskStateLabels,
  type ManagerChatTask,
  type ManagerChatTaskState,
} from "@ai-office/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge.tsx";

import { getJson } from "./api.ts";

// The Manager chat's live task list (PRD FR-24, ADR 0004): the work each
// of the Owner's chat requests spun off — an issue of its Batch, a
// Contractor, a research run — with where each stands and who works it,
// as Claude Code lists its sub-agents' tasks. Each opens its Agent's or
// Contractor's live view, and an issue its page on GitHub. The chat's
// stream says when it changed (a `tasks` frame, or a new message), and it
// is fetched again.

/** `GET /api/floors/:floorId/manager-chat/tasks`, newest request first. */
export const managerChatTasksQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "manager-chat-tasks"],
    queryFn: async () =>
      (
        await getJson(
          `/api/floors/${encodeURIComponent(floorId)}/manager-chat/tasks`,
          managerChatTaskListSchema,
        )
      ).tasks,
    refetchOnWindowFocus: false,
  });

const stateTones: Record<ManagerChatTaskState, BadgeTone> = {
  queued: "neutral",
  running: "info",
  in_review: "violet",
  done: "success",
  blocked: "danger",
};

const kindLabels: Record<ManagerChatTask["kind"], string> = {
  issue: "Issue",
  contractor: "Contractor",
  research: "Research",
};

/** Still to finish: queued, running or in review. */
const open = ({ state }: ManagerChatTask): boolean =>
  state !== "done" && state !== "blocked";

function Task({ floorId, task }: { floorId: string; task: ManagerChatTask }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-sm">
      <Badge tone={stateTones[task.state]}>
        {managerChatTaskStateLabels[task.state]}
      </Badge>
      <span className="min-w-0 flex-1 break-words">
        <span className="sr-only">{kindLabels[task.kind]}: </span>
        {task.title}
      </span>
      {task.issue !== null &&
        (task.url === null ? (
          <span className="text-xs text-muted-foreground">#{task.issue}</span>
        ) : (
          <a
            href={task.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline underline-offset-4"
            aria-label={`Issue #${String(task.issue)} on GitHub`}
          >
            #{task.issue}
          </a>
        ))}
      {task.agentId === null ? (
        <span className="text-xs text-muted-foreground">Not started</span>
      ) : (
        <Link
          to="/floors/$floorId/agents/$agentId"
          params={{ floorId, agentId: task.agentId }}
          className="text-xs underline underline-offset-4"
          aria-label={`Watch ${task.agentName ?? "its Agent"} work on “${task.title}”`}
        >
          {task.agentName ?? "Live view"}
        </Link>
      )}
    </li>
  );
}

/**
 * The tasks the Manager's chat requests spun off, folded under a button
 * that says how many are still going. Nothing shows until there are some.
 */
export function ChatTaskList({
  floorId,
  defaultOpen = true,
}: {
  floorId: string;
  /** Folded at first in a narrow panel. */
  defaultOpen?: boolean;
}) {
  const { data: tasks } = useQuery(managerChatTasksQuery(floorId));
  const [expanded, setExpanded] = useState(defaultOpen);
  const listId = useId();
  if (tasks === undefined || tasks.length === 0) {
    return null;
  }
  const going = tasks.filter(open).length;
  return (
    <section aria-label="Tasks" className="rounded-xl border px-3 py-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => {
          setExpanded((now) => !now);
        }}
        className="flex w-full items-center gap-1 text-left text-sm font-medium"
      >
        {expanded ? (
          <ChevronDown aria-hidden className="size-4" />
        ) : (
          <ChevronRight aria-hidden className="size-4" />
        )}
        Tasks
        <span className="font-normal text-muted-foreground">
          · {going} of {tasks.length} still going
        </span>
      </button>
      <ul
        id={listId}
        aria-label="Tasks the Manager spun off"
        hidden={!expanded}
        className="mt-1 max-h-48 divide-y overflow-y-auto"
      >
        {tasks.map((task) => (
          <Task key={task.id} floorId={floorId} task={task} />
        ))}
      </ul>
    </section>
  );
}
