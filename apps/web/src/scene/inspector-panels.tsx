import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import { whiteboardPath } from "@ai-office/shared";

import { Button } from "@/components/ui/button.tsx";
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";

import { AgentLiveView } from "../agent-live-view.tsx";
import { FloorAvailableSkills, managerChatHref } from "../available-skills.tsx";
import { AvatarEditor } from "../avatar-editor.tsx";
import { Bookshelf } from "../bookshelf.tsx";
import { agentsQuery } from "../floors.ts";
import { DirectChatPanel } from "../direct-chat.tsx";
import { ManagerChatPanel } from "../manager-chat.tsx";
import { Whiteboard } from "../whiteboard.tsx";
import { AgentCard } from "./agent-card.tsx";
import { CommunicationsAgentCard } from "./communications-agent-card.tsx";
import {
  floorInspectables,
  type InspectableKind,
  type InspectableObject,
} from "./inspectable.ts";
import {
  openInspectable,
  takeChatRequest,
  useChatRequest,
} from "./inspection.ts";
import { PageLink } from "./page-link.tsx";
import { FloorWallBoardPanel } from "./wall-board-panel.tsx";

// What each type of inspectable object's panel shows (PRD FR-58), by type.
// A monitor shows its Agent's live view, and a Floor's wall board its
// health, Notices, issues in progress, queues, rounds and tokens. An Agent
// shows its card (FR-63), from which its chat (the Manager chat, for the
// Manager) and its Avatar Editor (FR-13) open; the Communications Agent at
// the lobby's reception desk shows its own card, with the way to the
// Connections admin (FR-96). The
// whiteboard shows the Floor's Plans, editable while one awaits approval
// (FR-25.3), and the bookshelf the memory its Agents read, with where to
// edit each (FR-53 to FR-55); the bookshelf in the Manager's office the
// Floor's Available Skills (FR-73). A running Grilling Session's table
// (and, while it runs, the Manager and the whiteboard) shows the session
// chat (FR-83). The lobby board's Notices are for their own
// issue to add, by replacing its entry here; until then it links to the
// Notice Board.

export interface InspectorPanelProps {
  readonly object: InspectableObject;
  /** Opens a page of AI Office without a reload. */
  readonly navigate?: ((href: string) => void) | undefined;
}

/**
 * In a panel given a height, or filling the screen (inspector.tsx), what
 * this marks takes the room its own height leaves: a chat's messages, or
 * a long list, which scrolls within it.
 */
const fills =
  "group-data-sized/inspector:h-auto group-data-sized/inspector:max-h-none group-data-sized/inspector:min-h-48 group-data-sized/inspector:flex-1";

const floorOf = ({ location }: InspectableObject) =>
  location.kind === "floor" ? location.floorId : undefined;

/** A monitor: its Agent's live view, and a link to it on its own page. */
function MonitorPanel({ object, navigate }: InspectorPanelProps) {
  const floorId = floorOf(object);
  return (
    <>
      <p className="text-muted-foreground">
        This Agent&apos;s live activity: its terminal output, tool calls, diffs,
        and model calls with their tokens.
      </p>
      <AgentLiveView
        agentId={object.id}
        className={cn("h-[min(18rem,45vh)]", fills)}
      />
      {floorId !== undefined && (
        <PageLink
          href={`/floors/${encodeURIComponent(floorId)}/agents/${encodeURIComponent(object.id)}`}
          navigate={navigate}
        >
          Open the live view
        </PageLink>
      )}
    </>
  );
}

function WhiteboardPanel({ object, navigate }: InspectorPanelProps) {
  const floorId = floorOf(object);
  if (floorId === undefined) {
    return null;
  }
  return (
    <>
      <div className={cn("max-h-[60vh] overflow-y-auto pr-1", fills)}>
        <Whiteboard floorId={floorId} />
      </div>
      <PageLink href={whiteboardPath(floorId)} navigate={navigate}>
        Open the whiteboard on its own page
      </PageLink>
    </>
  );
}

function NoticeBoardPanel({ navigate }: InspectorPanelProps) {
  return (
    <>
      <p>Every Floor&apos;s Notices, for the whole Office.</p>
      <PageLink href="/notices" navigate={navigate}>
        Open the Notice Board
      </PageLink>
    </>
  );
}

/** A Floor's wall board: everything on it, live, with its links. */
function WallBoardPanel({ object, navigate }: InspectorPanelProps) {
  const floorId = floorOf(object);
  return floorId === undefined ? null : (
    <FloorWallBoardPanel floorId={floorId} navigate={navigate} />
  );
}

/**
 * An Agent: its card (FR-63), whose monitor opens in the Office, and whose
 * chat and Avatar Editor (FR-13) open in its place, the editor saving
 * redrawing the Agent in the scene at once. The Manager's chat is the
 * Manager chat, with its commands; any other Agent's is a direct chat.
 */
function AgentPanel({ object, navigate }: InspectorPanelProps) {
  return object.location.kind === "lobby" ? (
    <CommunicationsAgentCard navigate={navigate} />
  ) : (
    <FloorAgentPanel object={object} navigate={navigate} />
  );
}

/** One of a Floor's Agents: its card, or its Avatar Editor in its place. */
function FloorAgentPanel({ object, navigate }: InspectorPanelProps) {
  const floorId = floorOf(object);
  const [editingAvatar, setEditingAvatar] = useState(false);
  // Opened by the Office's "Chat with the Manager" button: on the chat.
  const [chatting, setChatting] = useState(
    () => useChatRequest.getState().agentId === object.id,
  );
  useEffect(() => {
    // Asked as the panel opened, the chat is already open; asked while
    // it is open, the card gives way to it.
    takeChatRequest(object.id);
    return useChatRequest.subscribe(({ agentId }) => {
      if (agentId === object.id && takeChatRequest(object.id)) {
        setEditingAvatar(false);
        setChatting(true);
      }
    });
  }, [object.id]);
  const { data: agents, isError } = useQuery({
    ...agentsQuery(floorId ?? ""),
    enabled: floorId !== undefined,
  });
  const agent = agents?.find(({ id }) => id === object.id);
  if (isError) {
    return <p role="alert">This Agent could not be loaded.</p>;
  }
  if (agent === undefined || agents === undefined || floorId === undefined) {
    return <LoadingMessage>Loading…</LoadingMessage>;
  }
  if (editingAvatar) {
    // Back comes first, so the editor's length never hides it.
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditingAvatar(false);
          }}
        >
          <ArrowLeft aria-hidden />
          Back to {agent.name}&apos;s card
        </Button>
        <div
          className={cn("max-h-[min(34rem,58vh)] overflow-y-auto pr-1", fills)}
        >
          <AvatarEditor agent={agent} compact />
        </div>
      </>
    );
  }
  if (chatting) {
    const manager = agent.role === "manager";
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setChatting(false);
          }}
        >
          <ArrowLeft aria-hidden />
          Back to {agent.name}&apos;s card
        </Button>
        {manager ? (
          <>
            <ManagerChatPanel
              floorId={floorId}
              compact
              className={cn("h-[min(30rem,55vh)]", fills)}
            />
            <PageLink href={managerChatHref(floorId)} navigate={navigate}>
              Open the Manager chat
            </PageLink>
          </>
        ) : (
          <DirectChatPanel
            place={{ kind: "agent", floorId, agentId: agent.id }}
            compact
            className={cn("h-[min(30rem,55vh)]", fills)}
          />
        )}
      </>
    );
  }
  const monitor = floorInspectables(floorId, agents).find(
    ({ kind, id }) => kind === "monitor" && id === agent.id,
  );
  return (
    <AgentCard
      agent={agent}
      navigate={navigate}
      onOpenMonitor={
        monitor === undefined
          ? undefined
          : () => {
              openInspectable(monitor);
            }
      }
      onOpenAvatarEditor={() => {
        setEditingAvatar(true);
      }}
      onOpenChat={() => {
        setChatting(true);
      }}
    />
  );
}

function BookshelfPanel({ object, navigate }: InspectorPanelProps) {
  const floorId = floorOf(object);
  if (floorId === undefined) {
    return null;
  }
  return (
    <div className={cn("max-h-[60vh] overflow-y-auto pr-1", fills)}>
      <Bookshelf floorId={floorId} navigate={navigate} />
    </div>
  );
}

/**
 * The bookshelf in the Manager's office: the Floor's Available Skills
 * (FR-73), each opened in a modal; running one opens the Manager chat with
 * its command in the box.
 */
function SkillsBookshelfPanel({ object, navigate }: InspectorPanelProps) {
  const floorId = floorOf(object);
  if (floorId === undefined) {
    return null;
  }
  return (
    <>
      <p className="text-muted-foreground">
        The Skills this Floor&apos;s Manager can run: the office library&apos;s
        and the repository&apos;s own.
      </p>
      <div className={cn("max-h-[50vh] overflow-y-auto pr-1", fills)}>
        <FloorAvailableSkills floorId={floorId} navigate={navigate} />
      </div>
      <PageLink href={managerChatHref(floorId)} navigate={navigate}>
        Open the Manager chat
      </PageLink>
    </>
  );
}

/**
 * A running Grilling Session: the Manager chat, with the session's bar and
 * its round's question cards, and the way to the whiteboard and the
 * Manager's card, which clicking them in the scene no longer opens while
 * the session runs.
 */
function GrillingSessionPanel({ object, navigate }: InspectorPanelProps) {
  const floorId = floorOf(object);
  const { data: agents } = useQuery({
    ...agentsQuery(floorId ?? ""),
    enabled: floorId !== undefined,
  });
  if (floorId === undefined) {
    return null;
  }
  const objects = floorInspectables(floorId, agents ?? [], { grilling: true });
  const manager = agents?.find(({ role }) => role === "manager");
  const board = objects.find(({ kind }) => kind === "whiteboard");
  const card = objects.find(
    ({ kind, id }) => kind === "agent" && id === manager?.id,
  );
  return (
    <>
      <p className="text-muted-foreground">
        {manager?.name ?? "The Manager"} is at the meeting room&apos;s table for
        the session: answer its questions here.
      </p>
      <ManagerChatPanel
        floorId={floorId}
        compact
        className={cn("h-[min(30rem,55vh)]", fills)}
      />
      <div className="flex flex-wrap gap-2">
        {board !== undefined && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              openInspectable(board);
            }}
          >
            Open the whiteboard
          </Button>
        )}
        {card !== undefined && manager !== undefined && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              openInspectable(card);
            }}
          >
            Open {manager.name}&apos;s card
          </Button>
        )}
      </div>
      <PageLink href={managerChatHref(floorId)} navigate={navigate}>
        Open the Manager chat
      </PageLink>
    </>
  );
}

/** Each type of inspectable object's panel. */
export const inspectorPanels: Record<
  InspectableKind,
  ComponentType<InspectorPanelProps>
> = {
  monitor: MonitorPanel,
  whiteboard: WhiteboardPanel,
  "notice-board": NoticeBoardPanel,
  "wall-board": WallBoardPanel,
  bookshelf: BookshelfPanel,
  "skills-bookshelf": SkillsBookshelfPanel,
  agent: AgentPanel,
  "grilling-session": GrillingSessionPanel,
};
