import { subjectOf, type EventType } from "@ai-office/events/schema";
import {
  eventHistoryResponseSchema,
  eventHistoryUrl,
} from "@ai-office/events/stream";
import {
  roleName,
  type Agent,
  type Floor,
  type FloorWallBoard,
  type WallBoardIssue,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

import { ActivityEntry, useAllAgents } from "./activity-feed.tsx";
import { agentStateText, IssueSummary } from "./agent-status.tsx";
import { getJson } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import type { EventNames } from "./event-text.ts";
import { agentsQuery, floorsQuery } from "./floors.ts";
import { NoticeItem, floorNameOf } from "./notice-board.tsx";
import { noticeEventTypes, noticesKey, noticesQuery } from "./notices.ts";
import type { InspectTarget } from "./scene/inspectable.ts";
import {
  StatusUpdateButton,
  StatusUpdatePanel,
  useDailyStatusUpdate,
  useGivenStatusUpdates,
} from "./status-update.tsx";
import { floorTokenUsageQuery } from "./token-caps.tsx";
import {
  currentIssueOf,
  floorHealth,
  healthTokens,
  tokenRefreshMs,
  wallBoardEventTypes,
  wallBoardQuery,
} from "./wall-board.ts";
import { backgroundOf } from "./scene/stage-colours.ts";

// The Office on a phone (PRD §7, Responsiveness): a 2D view in place of the
// 3D one, which phones do not get. One page, in sections a thumb reaches
// from the list at the top: the Notice Board, with each Notice's actions;
// the latest of the Activity Feed; every Floor, with its health, its
// Agents (each one's state, as the Office shows it, and the issue it is
// on) and its issues in progress; and Admin. All of it is kept live by the
// event stream. An address that names an object in the Office (an Agent's
// name links to one) brings the part that shows it into view.

/** How many of the latest events the Activity section shows. */
export const latestActivity = 10;

/** The id of each section, for the list at the top and the Office's address. */
export const office2dSections = {
  notices: "office-notices",
  activity: "office-activity",
  floors: "office-floors",
  admin: "office-admin",
} as const;

const sectionLabels: Record<keyof typeof office2dSections, string> = {
  notices: "Notice Board",
  activity: "Activity",
  floors: "Floors",
  admin: "Settings",
};

export const floorSectionId = (floorId: string) => `office-floor-${floorId}`;

export const agentEntryId = (floorId: string, agentId: string) =>
  `office-agent-${floorId}-${agentId}`;

/**
 * The part of the 2D view that shows an object the Office's address
 * names: an Agent (or its monitor) is its entry, any other object of a
 * Floor is the Floor, and the lobby's Notice Board is the Notice Board.
 */
export function office2dTargetId(target: InspectTarget): string | undefined {
  const { kind, id, location } = target;
  if (location.kind === "lobby") {
    return kind === "notice-board" ? office2dSections.notices : undefined;
  }
  return kind === "agent" || kind === "monitor"
    ? agentEntryId(location.floorId, id)
    : floorSectionId(location.floorId);
}

/** Scrolls an element into view and moves focus to it. */
function bringIntoView(element: HTMLElement | null) {
  element?.scrollIntoView({ block: "start" });
  element?.focus({ preventScroll: true });
}

/** An in-page link that brings its target into view, focus and all. */
function JumpLink({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        bringIntoView(document.getElementById(to));
      }}
    >
      {children}
    </a>
  );
}

/** Brings `element` into view once, when it is the one the address names. */
function useTargeted<T extends HTMLElement>(targeted: boolean) {
  const element = useRef<T>(null);
  useEffect(() => {
    if (targeted) {
      bringIntoView(element.current);
    }
  }, [targeted]);
  return element;
}

const targetedClass = "ring-[3px] ring-ring/50";

/** A section of the page, with its heading and a way back to the top. */
function Section({
  id,
  title,
  description,
  targeted = false,
  children,
}: {
  id: string;
  title: string;
  description: string;
  targeted?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const element = useTargeted<HTMLElement>(targeted);
  return (
    <section
      ref={element}
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-current={targeted ? "true" : undefined}
      className={cn(
        "scroll-mt-4 space-y-3 rounded-xl outline-none",
        targeted && targetedClass,
      )}
    >
      <header className="space-y-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}

/** A link to a page of AI Office (its child), as a button a finger can tap. */
function PageButton({ children }: { children: ReactNode }) {
  return (
    <Button asChild size="sm" variant="outline">
      {children}
    </Button>
  );
}

/** The events that change what the Floors' section shows. */
const floorEventTypes: readonly EventType[] = [
  ...wallBoardEventTypes,
  "floor.created",
  "floor.archived",
  "handoff",
];

/**
 * Keeps the Notices and the Floors current, on one stream: each Notice
 * event reads the Notices again, and each event of a Floor reads that
 * Floor's Agents, wall board and tokens again (a Floor added, archived or
 * changed, the list of Floors too; an office-wide change, every Floor).
 * Each (re)connection reads them all again, in case something changed
 * while it was down.
 */
function useLiveOffice() {
  const queryClient = useQueryClient();
  const { status } = useEventStream(
    { types: [...noticeEventTypes, ...floorEventTypes] },
    {
      onEvent: ({ event }, client) => {
        if (noticeEventTypes.includes(event.type)) {
          void client.invalidateQueries({ queryKey: noticesKey });
        }
        const { floorId } = subjectOf(event);
        if (floorId === null) {
          // An office-wide change, such as an AI Provider's default Model,
          // may change every Floor's Agents.
          if (!noticeEventTypes.includes(event.type)) {
            void client.invalidateQueries({ queryKey: ["floors"] });
          }
          return;
        }
        // The Floor's own queries; its name and the list, when it changes.
        void client.invalidateQueries({ queryKey: ["floors", floorId] });
        if (
          event.type.startsWith("floor.") ||
          event.type === "config.changed"
        ) {
          void client.invalidateQueries({
            queryKey: floorsQuery.queryKey,
            exact: true,
          });
        }
      },
    },
  );
  useEffect(() => {
    if (status === "open") {
      void queryClient.invalidateQueries({ queryKey: noticesKey });
      void queryClient.invalidateQueries({ queryKey: ["floors"] });
    }
  }, [status, queryClient]);
}

function NoticesSection({
  floors,
  targeted,
}: {
  floors: readonly Floor[] | undefined;
  targeted: boolean;
}) {
  const { data: notices, isError } = useQuery(noticesQuery());
  return (
    <Section
      id={office2dSections.notices}
      title="Notice Board"
      description="What needs you, from every Floor. Each Notice stays until you dismiss it or take its action."
      targeted={targeted}
    >
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          The Notices could not be loaded.
        </p>
      )}
      {notices?.length === 0 && (
        <p className="text-muted-foreground">
          No Notices. Nothing needs you right now.
        </p>
      )}
      {notices !== undefined && notices.length > 0 && (
        <ul aria-label="Notices" className="space-y-3">
          {notices.map((notice) => (
            <NoticeItem
              key={notice.id}
              notice={notice}
              floorName={floorNameOf(floors, notice)}
              highlighted={false}
            />
          ))}
        </ul>
      )}
      <PageButton>
        <Link to="/notices">Open the Notice Board</Link>
      </PageButton>
    </Section>
  );
}

function ActivitySection({ floors }: { floors: readonly Floor[] | undefined }) {
  const agents = useAllAgents(floors);
  const names: EventNames = {
    agent: (agentId) => agents.get(agentId)?.name ?? agentId,
    floor: (floorId) =>
      floors?.find(({ id }) => id === floorId)?.name ?? floorId,
  };
  const history = useQuery({
    queryKey: ["office-2d", "activity"],
    queryFn: () =>
      getJson(
        eventHistoryUrl({}, {}, undefined, latestActivity),
        eventHistoryResponseSchema,
      ),
    // New events come by the stream.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const newest = history.data?.events[0]?.id ?? 0;
  // Once the latest are read, new ones stream in at the top.
  const { events: streamed } = useEventStream(
    {},
    {
      enabled: history.isSuccess,
      after: newest,
      maxEvents: latestActivity,
    },
  );
  const entries = [
    ...streamed.filter(({ id }) => id > newest).toReversed(),
    ...(history.data?.events ?? []),
  ].slice(0, latestActivity);

  return (
    <Section
      id={office2dSections.activity}
      title="Activity"
      description="The latest of the Activity Feed, newest first."
    >
      {history.isError && (
        <p role="alert" className="text-sm text-destructive">
          The Activity Feed could not be loaded.
        </p>
      )}
      {history.isSuccess && entries.length === 0 && (
        <p className="text-muted-foreground">Nothing has happened yet.</p>
      )}
      {entries.length > 0 && (
        <ol aria-label="Latest activity" className="rounded-xl border px-4">
          {entries.map((stored) => (
            <ActivityEntry
              key={stored.id}
              stored={stored}
              floors={floors}
              names={names}
            />
          ))}
        </ol>
      )}
      <PageButton>
        <Link to="/activity">Open the Activity Feed</Link>
      </PageButton>
    </Section>
  );
}

function AgentEntry({
  agent,
  board,
  targeted,
}: {
  agent: Agent;
  board: FloorWallBoard | undefined;
  targeted: boolean;
}) {
  const headingId = useId();
  const element = useTargeted<HTMLLIElement>(targeted);
  const current =
    board === undefined ? undefined : currentIssueOf(board, agent.id);
  return (
    <li
      ref={element}
      id={agentEntryId(agent.floorId, agent.id)}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-current={targeted ? "true" : undefined}
      className={cn(
        "scroll-mt-4 space-y-2 rounded-lg border bg-card p-3 outline-none",
        targeted && targetedClass,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h4 id={headingId} className="font-medium">
          {agent.name}
        </h4>
        <span className="text-xs text-muted-foreground">
          {`${roleName(agent.role)} · ${agent.aiProvider} ${agent.model}`}
        </span>
      </div>
      <p className="text-sm" data-testid="agent-state">
        {agentStateText(agent, board)}
      </p>
      <div className="text-sm">
        <span className="text-muted-foreground">Issue: </span>
        {current === undefined ? "None" : <IssueSummary issue={current} />}
      </div>
      <div className="flex flex-wrap gap-2">
        <PageButton>
          <Link
            to="/floors/$floorId/agents/$agentId/chat"
            params={{ floorId: agent.floorId, agentId: agent.id }}
            aria-label={`Chat with ${agent.name}`}
          >
            Chat
          </Link>
        </PageButton>
        <PageButton>
          <Link
            to="/floors/$floorId/agents/$agentId"
            params={{ floorId: agent.floorId, agentId: agent.id }}
            aria-label={`${agent.name}'s live view`}
          >
            Live view
          </Link>
        </PageButton>
        <PageButton>
          <Link
            to="/agent-settings"
            search={{ floor: agent.floorId, agent: agent.id }}
            aria-label={`${agent.name}'s config`}
          >
            Config
          </Link>
        </PageButton>
      </div>
    </li>
  );
}

function IssueEntry({
  issue,
  board,
  name,
}: {
  issue: WallBoardIssue;
  board: FloorWallBoard;
  name: (agentId: string) => string;
}) {
  return (
    <li className="space-y-1 rounded-lg border bg-card p-3 text-sm">
      <IssueSummary issue={issue} />
      <p>
        {issue.agentIds.length === 0 ? (
          "No Agent to work it"
        ) : (
          <>
            {issue.status === "working" ? "By " : "For "}
            {issue.agentIds.map((agentId, index) => (
              <span key={agentId}>
                {index > 0 && ", "}
                <JumpLink
                  to={agentEntryId(board.floorId, agentId)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {name(agentId)}
                </JumpLink>
              </span>
            ))}
          </>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        Review rounds {issue.reviewRounds} of {board.roundCap}
        {issue.qaRounds > 0 &&
          ` · QA rounds ${String(issue.qaRounds)} of ${String(board.qaRoundCap)}`}
      </p>
    </li>
  );
}

function FloorSection({
  floor,
  target,
}: {
  floor: Floor;
  /** The id of the part the address names, if any. */
  target: string | undefined;
}) {
  const headingId = useId();
  const element = useTargeted<HTMLElement>(target === floorSectionId(floor.id));
  const agents = useQuery(agentsQuery(floor.id));
  const board = useQuery(wallBoardQuery(floor.id));
  const notices = useQuery(noticesQuery(floor.id));
  const usage = useQuery({
    ...floorTokenUsageQuery(floor.id),
    refetchInterval: tokenRefreshMs,
  });
  const name = (agentId: string) =>
    agents.data?.find(({ id }) => id === agentId)?.name ?? agentId;
  const health =
    notices.data === undefined ||
    board.data === undefined ||
    usage.data === undefined
      ? undefined
      : floorHealth({
          notices: notices.data,
          board: board.data,
          usage: usage.data,
          agentName: name,
        });
  const targeted = target === floorSectionId(floor.id);
  // The day's Status update (FR-23a), when the address opens this Floor:
  // shown here, with no walk; and those given by themselves, such as the
  // hourly one while the Floor's Agents work.
  useDailyStatusUpdate(floor.id, targeted);
  useGivenStatusUpdates(floor.id);

  return (
    <section
      ref={element}
      id={floorSectionId(floor.id)}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-current={targeted ? "true" : undefined}
      className={cn(
        "scroll-mt-4 space-y-4 rounded-xl border p-4 outline-none",
        targeted && targetedClass,
      )}
    >
      <header className="space-y-1">
        <h3 id={headingId} className="text-lg font-semibold">
          {floor.name}
        </h3>
        <p className="font-mono text-xs text-muted-foreground">
          {floor.repository}
        </p>
        {health !== undefined && (
          <p
            className="flex items-center gap-2 text-sm font-medium"
            data-health={health.level}
          >
            <span
              aria-hidden
              className={cn(
                "size-3 rounded-full",
                backgroundOf(healthTokens[health.level]),
              )}
            />
            {health.label}
          </p>
        )}
        {health !== undefined && health.reasons.length > 0 && (
          <ul aria-label="Why" className="list-disc pl-5 text-sm">
            {health.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </header>
      <StatusUpdatePanel floorId={floor.id} className="w-full max-w-none" />
      <div className="flex flex-wrap gap-2">
        <StatusUpdateButton floorId={floor.id} />
        <PageButton>
          <Link
            to="/notices"
            search={{ floorId: floor.id }}
            aria-label={`${floor.name}'s Notices`}
          >
            Notices
          </Link>
        </PageButton>
        <PageButton>
          <Link to="/floors/$floorId/manager" params={{ floorId: floor.id }}>
            Chat with the Manager
          </Link>
        </PageButton>
        <PageButton>
          <Link
            to="/floor-settings/$floorId"
            params={{ floorId: floor.id }}
            aria-label={`${floor.name}'s settings`}
          >
            Floor settings
          </Link>
        </PageButton>
      </div>
      {(agents.isError || board.isError) && (
        <p role="alert" className="text-sm text-destructive">
          Some of this Floor could not be loaded.
        </p>
      )}
      <div className="space-y-2">
        <h4 className="font-medium">
          Agents
          {agents.data !== undefined && ` (${String(agents.data.length)})`}
        </h4>
        {agents.data !== undefined && (
          <ul aria-label={`${floor.name}'s Agents`} className="space-y-2">
            {agents.data.map((agent) => (
              <AgentEntry
                key={agent.id}
                agent={agent}
                board={board.data}
                targeted={target === agentEntryId(floor.id, agent.id)}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="font-medium">
          In progress
          {board.data !== undefined && ` (${String(board.data.issues.length)})`}
        </h4>
        {board.data?.issues.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No issue is in progress.
          </p>
        )}
        {board.data !== undefined && board.data.issues.length > 0 && (
          <ul
            aria-label={`${floor.name}'s issues in progress`}
            className="space-y-2"
          >
            {board.data.issues.map((issue) => (
              <IssueEntry
                key={`${String(issue.issue)}:${issue.stage}`}
                issue={issue}
                board={board.data}
                name={name}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FloorsSection({
  floors,
  isError,
  target,
}: {
  floors: readonly Floor[] | undefined;
  isError: boolean;
  target: string | undefined;
}) {
  return (
    <Section
      id={office2dSections.floors}
      title="Floors"
      description="Each Floor's health, its Agents and the issues in progress."
    >
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          The Floors could not be loaded.
        </p>
      )}
      {floors?.length === 0 && (
        <p className="text-muted-foreground">
          No Floors yet. Add one in Floor Settings.
        </p>
      )}
      {floors?.map((floor) => (
        <FloorSection key={floor.id} floor={floor} target={target} />
      ))}
    </Section>
  );
}

function AdminSection({ floors }: { floors: readonly Floor[] | undefined }) {
  return (
    <Section
      id={office2dSections.admin}
      title="Settings"
      description="Configuration for the Office, its Floors and the AI Gateway."
    >
      <nav aria-label="Settings pages">
        <ul className="grid gap-2">
          <li>
            <PageButton>
              <Link to="/general-settings">General Settings</Link>
            </PageButton>
          </li>
          {floors?.map((floor) => (
            <li key={floor.id}>
              <PageButton>
                <Link
                  to="/floor-settings/$floorId"
                  params={{ floorId: floor.id }}
                >
                  {floor.name}: Floor Settings
                </Link>
              </PageButton>
            </li>
          ))}
          <li>
            <PageButton>
              <Link to="/gateway">Gateway requests</Link>
            </PageButton>
          </li>
          <li>
            <PageButton>
              <Link to="/analytics">Analytics</Link>
            </PageButton>
          </li>
        </ul>
      </nav>
    </Section>
  );
}

/** The Office in 2D, for a phone. */
export function Office2D({
  inspect,
}: {
  /** An object the Office's address names: the part that shows it comes into view. */
  inspect?: InspectTarget | undefined;
} = {}) {
  useLiveOffice();
  const floors = useQuery(floorsQuery);
  const target = inspect === undefined ? undefined : office2dTargetId(inspect);

  return (
    <div className="space-y-8" data-testid="office-2d">
      <nav aria-label="Office sections">
        <ul className="grid grid-cols-2 gap-2">
          {(
            Object.keys(office2dSections) as (keyof typeof office2dSections)[]
          ).map((section) => (
            <li key={section}>
              <Button
                asChild
                variant="secondary"
                className="w-full justify-start"
              >
                <JumpLink to={office2dSections[section]}>
                  {sectionLabels[section]}
                </JumpLink>
              </Button>
            </li>
          ))}
        </ul>
      </nav>
      <NoticesSection
        floors={floors.data}
        targeted={target === office2dSections.notices}
      />
      <ActivitySection floors={floors.data} />
      <FloorsSection
        floors={floors.data}
        isError={floors.isError}
        target={target}
      />
      <AdminSection floors={floors.data} />
    </div>
  );
}
