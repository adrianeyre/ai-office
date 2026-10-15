import type { EventFilter, EventType } from "@ai-office/events/schema";
import {
  eventHistoryResponseSchema,
  eventHistoryUrl,
  maxEventHistoryPageSize,
} from "@ai-office/events/stream";
import { greeting as greetingFor, pauseGrillingText } from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Armchair,
  Gauge,
  MessageSquare,
  Presentation,
  RotateCcw,
  Settings2,
} from "lucide-react";
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { create } from "zustand";

import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";

import { getJson } from "../api.ts";
import { contextUsageQuery, withContextUsageEvent } from "../context-usage.tsx";
import { useEventStream } from "../event-stream.ts";
import { agentsQuery, floorsQuery, refreshFloorsOn } from "../floors.ts";
import {
  grillingQueryKey,
  grillingSessionQuery,
  grillingSessionsQuery,
} from "../grilling.tsx";
import { useChatSender } from "../manager-chat.tsx";
import { MeetingRoomPanel } from "../meeting-room.tsx";
import { noticesQuery, useLiveNotices } from "../notices.ts";
import { floorActivitiesQuery } from "../activities-card.tsx";
import {
  communicationsAgentQuery,
  connectionsQuery,
} from "../connections-page.tsx";
import { gatewayKeysQuery } from "../gateway-keys-card.tsx";
import { ownerPasswordsQuery } from "../owner-passwords.tsx";
import { lobbyCastQuery } from "../people.ts";
import { seasonalEventsQuery } from "../seasonal-events.ts";
import { rolesQuery } from "../role-library.tsx";
import { sessionQuery } from "../session.ts";
import {
  StatusUpdateButton,
  StatusUpdatePanel,
  useDailyStatusUpdate,
  useGivenStatusUpdates,
} from "../status-update.tsx";
import { floorTokenUsageQuery } from "../token-caps.tsx";
import { tokenRefreshMs, wallBoardQuery } from "../wall-board.ts";
import { aboveHeads, freshStartSignals } from "./above-head.ts";
import { agentLooks, floorNeedsOwner } from "./agent-state.ts";
import { destination } from "./camera-rig.ts";
import {
  defaultView,
  officeViews,
  useCameraStore,
  type OfficeView,
} from "./camera-store.ts";
import type { FloorGrilling } from "./floor.tsx";
import type { FloorAgent } from "./floor-layout.ts";
import { grillingBoard } from "./grilling-board.ts";
import { factFindingVisits } from "./grilling-walks.ts";
import { useFpsStore } from "./fps.ts";
import { handoffTickets } from "./handoff-walks.ts";
import { meetingSignals } from "./meeting-walks.ts";
import { contractorSignals } from "./contractor-walks.ts";
import {
  floorInspectables,
  isInspectable,
  lobbyInspectables,
  type InspectableObject,
  type InspectTarget,
} from "./inspectable.ts";
import {
  closeInspectable,
  openAgentChat,
  openInspectable,
} from "./inspection.ts";
import { InspectablesList, InspectorPanel } from "./inspector.tsx";
import { isRiding, liftLocation } from "./lift.ts";
import { useLiftStore } from "./lift-store.ts";
import { liftStops, lobby, sameLocation, stopAt } from "./lift-stops.ts";
import { ActorCallButton } from "./actor-call.tsx";
import { noSeason, seasonAt, useSeason } from "./season.ts";
import { BoardSummary, FloorPicker, panelClass } from "./lobby-panels.tsx";
import {
  monitorActivityEventTypes,
  monitorEventTypes,
  monitorScreens,
  monitorStatusEventTypes,
} from "./monitor-preview.ts";
import { boardPreview } from "./notice-board-preview.ts";
import { OfficeSound, SoundControls } from "./office-sound.tsx";
import { qualityLevels, qualityPresets } from "./quality.ts";
import {
  emptyTally,
  failingConnections,
  receptionRefreshMs,
  tallySent,
} from "./reception-desk.ts";
import { useSceneSettings } from "./scene-settings.ts";
import { sameSelection, useSelectionStore } from "./selection-store.ts";
import { useDeskReturnStore } from "./desk-return.ts";
import { FastForwardButton } from "./fast-forward-button.tsx";
import { useMeetingFastForwardStore } from "./meeting-fast-forward.ts";
import { useMeetingRoomCall } from "./meeting-room-call.ts";
import { webgl } from "./webgl.ts";

export { webgl };

// The Office page's 3D view: the canvas, and the HTML panels over it (PRD
// §7: text is never rendered in the scene; panels are HTML). Everything the
// panels do is a button or a form control, so it works from the keyboard.
// The panels take the pointer; the space between them leaves it to the
// scene. The Floors and the open Notices, kept live, become the lobby's
// Notice Board preview and the lift's stops; on a Floor, its Agents, kept
// live too, are its desks, and what they do lights up their monitors. Their
// states, from their monitors, their pauses and the Floor's wall board, and
// the Floor's action Notices, are what the Office shows of them (FR-62),
// and each Handoff on the Floor is walked from desk to desk (FR-59). Over
// each Agent's head float its Context Usage bar, while it has a session
// going, and its tokens today, unless the scene settings switch them off
// (FR-62, FR-85). While
// a Grilling Session runs, its Manager sits in the meeting room, and the
// Agents it sends to find facts visit it there (FR-83). In the lobby, the
// Communications Agent sits at the reception desk as the receptionist: its
// Connections, read every few seconds there, drop an envelope into its
// out-tray for each message sent, and show the red marker while one is
// failing (FR-96).
// The objects there that can be inspected (PRD
// FR-58) are listed for the keyboard, and the one open shows its panel;
// the Office's address names it, so it can be opened from a link.

// three.js and the scene load only when the Office is opened, so they stay
// out of the other pages' bundle.
const OfficeScene = lazy(() =>
  import("./office-scene.tsx").then(({ OfficeScene }) => ({
    default: OfficeScene,
  })),
);

const viewLabels: Record<OfficeView, string> = {
  overview: "Overview",
  plan: "Plan",
  close: "Close up",
};

/**
 * A message in place of the scene. It sits on the scene's sky, which is
 * light in both modes, so it is written in the palette's ink.
 */
function SceneMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <p role="status" className="max-w-md text-sm text-office-ink">
        {children}
      </p>
    </div>
  );
}

function Unavailable({ children }: { children: ReactNode }) {
  return (
    <SceneMessage>
      {children} The Notice Board, the Activity Feed and Admin work as usual.
    </SceneMessage>
  );
}

/** Shows why the scene stopped, such as a WebGL context that could not start. */
class SceneBoundary extends Component<
  { children: ReactNode },
  { error: Error | undefined }
> {
  override state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    return this.state.error === undefined ? (
      this.props.children
    ) : (
      <Unavailable>
        The 3D Office could not start ({this.state.error.message}).
      </Unavailable>
    );
  }
}

function ViewPicker() {
  const flyTo = useCameraStore((state) => state.flyTo);
  const current = useCameraStore((state) => destination(state.rig));
  return (
    <div
      role="group"
      aria-label="Camera view"
      className={cn(panelClass, "flex gap-1")}
    >
      {(Object.keys(officeViews) as OfficeView[]).map((view) => (
        <Button
          key={view}
          size="sm"
          variant={current === view ? "secondary" : "ghost"}
          aria-pressed={current === view}
          onClick={() => {
            flyTo(view);
          }}
        >
          {viewLabels[view]}
        </Button>
      ))}
      {/* Back from wherever the mouse or fingers left it. */}
      <Button
        size="sm"
        variant="ghost"
        title="Drag to turn and tilt, right-drag or Shift-drag to pan, scroll to zoom"
        onClick={() => {
          flyTo(defaultView);
        }}
      >
        <RotateCcw aria-hidden />
        Reset view
      </Button>
    </div>
  );
}

/**
 * The way to the Floor's Manager chat, over the scene where it is seen
 * first: it flies to the Manager and opens its chat, or, while a Grilling
 * Session runs, the session's table, whose panel is the Manager chat.
 */
function ManagerChatButton({
  objects,
  managerId,
}: {
  objects: readonly InspectableObject[];
  managerId: string;
}) {
  const session = objects.find(({ kind }) => kind === "grilling-session");
  const manager = objects.find(
    ({ kind, id }) => kind === "agent" && id === managerId,
  );
  const target = session ?? manager;
  if (target === undefined) {
    return null;
  }
  return (
    <Button
      className="pointer-events-auto shadow-lg"
      onClick={() => {
        if (target === manager) {
          openAgentChat(target);
        } else {
          openInspectable(target);
        }
      }}
    >
      <MessageSquare aria-hidden />
      Chat with the Manager
    </Button>
  );
}

/**
 * Meeting Room, beside the Manager chat's button: the whole Floor walks to
 * the meeting room and sits round the table (meeting-room-call.ts), and
 * the Meeting Room's panel opens on the day's work: a PRD, issues, a
 * Batch, a Status update, or anything else (meeting-room.tsx). While a
 * Grilling Session runs it says so, and the panel carries it on.
 */
function MeetingRoomButton({
  floorId,
  inSession,
}: {
  floorId: string;
  inSession: boolean;
}) {
  const called = useMeetingRoomCall((state) => state.floorId === floorId);
  const panelOpen = useMeetingRoomCall((state) => state.panelOpen);
  return (
    <div className="flex items-center gap-2">
      <Button
        className="pointer-events-auto shadow-lg"
        aria-expanded={called && panelOpen}
        onClick={() => {
          if (!called && !inSession) {
            useMeetingFastForwardStore.getState().call("meeting-room");
          }
          useMeetingRoomCall.getState().call(floorId);
        }}
      >
        <Presentation aria-hidden />
        {inSession ? "Meeting Room (in session)" : "Meeting Room"}
      </Button>
      <FastForwardButton gathering="meeting-room" />
    </div>
  );
}

/**
 * "Return to desks", beside Meeting Room: shown only while someone is away
 * from their desk for something the Owner may call off. The Meeting Room
 * is left, and a running Grilling Session is paused, as its Pause button
 * does, so the Meeting Room resumes it later, and the Floor walks back
 * from the meeting room; every
 * Agent on an idle activity walks back too, resting a while before it
 * idles again (desk-return.ts). Kickoffs, Wrap-ups, Handoffs and
 * fact-finding are work, and carry on.
 */
function ReturnToDesksButton({
  floorId,
  inSession,
}: {
  floorId: string;
  inSession: boolean;
}) {
  const queryClient = useQueryClient();
  const wandering = useDeskReturnStore((state) => state.wandering);
  const called = useMeetingRoomCall((state) => state.floorId === floorId);
  const { send, sending, ready } = useChatSender(floorId);
  if (!wandering && !inSession && !called) {
    return null;
  }
  return (
    <Button
      variant="secondary"
      className="pointer-events-auto shadow-lg"
      disabled={inSession && (sending || !ready)}
      onClick={() => {
        useDeskReturnStore.getState().returnToDesks();
        useMeetingRoomCall.getState().end();
        if (inSession) {
          void send(pauseGrillingText).then((sent) => {
            if (sent) {
              void queryClient.invalidateQueries({
                queryKey: grillingQueryKey(floorId),
              });
            }
          });
        }
      }}
    >
      <Armchair aria-hidden />
      Return to desks
    </Button>
  );
}

function SettingsPanel({
  floorId,
}: {
  /** The Floor the lift is at, whose ambience can be chosen; none in the lobby. */
  floorId: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const quality = useSceneSettings((settings) => settings.quality);
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const showFps = useSceneSettings((settings) => settings.showFps);
  const setQuality = useSceneSettings((settings) => settings.setQuality);
  const setReducedMotion = useSceneSettings(
    (settings) => settings.setReducedMotion,
  );
  const setShowFps = useSceneSettings((settings) => settings.setShowFps);
  const showAboveHead = useSceneSettings((settings) => settings.showAboveHead);
  const setShowAboveHead = useSceneSettings(
    (settings) => settings.setShowAboveHead,
  );

  return (
    <div className="flex flex-col items-end gap-2">
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
        <Settings2 aria-hidden />
        Scene settings
      </Button>
      <div
        id={id}
        hidden={!open}
        className={cn(panelClass, "w-56 max-w-full space-y-3 p-3")}
      >
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">Quality</legend>
          {qualityLevels.map((level) => (
            <label key={level} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-quality`}
                className="size-4 accent-primary"
                checked={quality === level}
                onChange={() => {
                  setQuality(level);
                }}
              />
              {qualityPresets[level].label}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={reducedMotion}
            onChange={(event) => {
              setReducedMotion(event.target.checked);
            }}
          />
          Reduce motion
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={showFps}
            onChange={(event) => {
              setShowFps(event.target.checked);
            }}
          />
          Show frame rate
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={showAboveHead}
            onChange={(event) => {
              setShowAboveHead(event.target.checked);
            }}
          />
          Show Context Usage and tokens above Agents
        </label>
        <SoundControls floorId={floorId} />
      </div>
    </div>
  );
}

function FpsOverlay() {
  const reading = useFpsStore((state) => state.reading);
  return (
    <p
      aria-label="Frame rate"
      className={cn(
        panelClass,
        "flex items-center gap-2 font-mono text-xs tabular-nums",
      )}
    >
      <Gauge aria-hidden className="size-3.5" />
      {reading === undefined
        ? "Measuring…"
        : `${String(Math.round(reading.fps))} fps · ${reading.frameMs.toFixed(1)} ms`}
    </p>
  );
}

/**
 * The events that add or remove a desk on a Floor, or change an Agent's
 * name or Avatar (from the Avatar Editor, here or in another window).
 */
const teamEventTypes: readonly EventType[] = [
  "agent.created",
  "agent.removed",
  "config.changed",
];

/**
 * The events that change what the Office shows of an Agent's state
 * (FR-62) beyond its monitor: the work waiting for it (its pile of
 * tickets), its work moving to and from review (which a Handoff to review
 * says), and its status (a Token Cap reached, or resumed). Each reads the
 * Floor's wall board again. Handoffs are walked too (FR-59).
 */
const agentStateEventTypes: readonly EventType[] = [
  "agent.queue_changed",
  "agent.status_changed",
  "issue.assigned",
  "issue.label_changed",
  "handoff",
];

/**
 * The events that gather a Floor's Agents in the meeting room, and let them
 * go (FR-60): its Kickoffs, Wrap-ups and Status updates (FR-23a).
 */
const meetingEventTypes: readonly EventType[] = [
  "batch.kickoff_started",
  "batch.kickoff_ended",
  "batch.finished",
  "status_update.given",
];

/**
 * The events that walk a Contractor in from the lift and out to it (ADR
 * 0004); its `agent.created` and `agent.removed` change the team.
 */
const contractorEventTypes: readonly EventType[] = [
  "contractor.added",
  "contractor.left",
];

/**
 * The events of a Floor's Grilling Sessions the Office shows (FR-83): each
 * change to a session reads its sessions again; fact-finding is walked.
 */
const grillingEventTypes: readonly EventType[] = [
  "grilling.session_changed",
  "grilling.fact_finding_started",
  "grilling.fact_finding_stopped",
];

/**
 * The Agents of the Floor the lift is at and its wall board, kept live on
 * one stream of the Floor's events: an Agent added, removed or changed
 * reads them both again, and each event that changes an Agent's state
 * reads the board again; so does each (re)connection, in case something
 * changed while it was down. The same stream brings the Floor's Handoffs,
 * those missed while it was down included, its Kickoffs and Wrap-ups, and
 * its Grilling Sessions' changes and fact-finding. Undefined in the lobby,
 * and until they load.
 */
/**
 * How much older than the moment a Floor is shown an event may be and
 * still be walked: allowance for the server's clock and the page's
 * disagreeing a little.
 */
const replaySlackMs = 15_000;

/** When the Floor the lift is at was shown: walks are for what comes after. */
const useFloorShown = create<{
  readonly floorId: string | undefined;
  readonly at: number;
}>()(() => ({ floorId: undefined, at: 0 }));

function useFloorTeam(floorId: string | undefined) {
  const queryClient = useQueryClient();
  const { status, events } = useEventStream(
    {
      floorId,
      types: [
        ...teamEventTypes,
        ...agentStateEventTypes,
        ...meetingEventTypes,
        ...contractorEventTypes,
        ...grillingEventTypes,
      ],
    },
    {
      enabled: floorId !== undefined,
      onEvent: ({ event }, client) => {
        if (
          floorId === undefined ||
          meetingEventTypes.includes(event.type) ||
          contractorEventTypes.includes(event.type)
        ) {
          return;
        }
        if (grillingEventTypes.includes(event.type)) {
          if (event.type === "grilling.session_changed") {
            void client.invalidateQueries({
              queryKey: grillingQueryKey(floorId),
            });
          }
          return;
        }
        if (teamEventTypes.includes(event.type)) {
          void client.invalidateQueries(agentsQuery(floorId));
          // The Floor's settings, such as the name its lift button shows.
          refreshFloorsOn(event, client);
        }
        void client.invalidateQueries(wallBoardQuery(floorId));
      },
    },
  );
  useEffect(() => {
    if (status === "open" && floorId !== undefined) {
      void queryClient.invalidateQueries(wallBoardQuery(floorId));
      void queryClient.invalidateQueries({
        queryKey: grillingQueryKey(floorId),
      });
    }
  }, [status, queryClient, floorId]);
  const { data: team } = useQuery({
    ...agentsQuery(floorId ?? ""),
    enabled: floorId !== undefined,
  });
  const { data: board } = useQuery({
    ...wallBoardQuery(floorId ?? ""),
    enabled: floorId !== undefined,
  });
  const { data: sessions } = useQuery({
    ...grillingSessionsQuery(floorId ?? ""),
    enabled: floorId !== undefined,
  });
  const running = sessions?.sessions.find(({ status }) => status === "active");
  const { data: session } = useQuery({
    ...grillingSessionQuery(floorId ?? "", running?.id ?? 0),
    enabled: floorId !== undefined && running !== undefined,
  });
  const grilling = useMemo((): FloorGrilling | undefined => {
    if (running === undefined) {
      return undefined;
    }
    const detail = session?.session;
    return {
      sessionId: running.id,
      board: detail?.id === running.id ? grillingBoard(detail) : undefined,
    };
  }, [running, session]);
  // Only what happens once the Floor is shown is walked: the events the
  // stream brings back on a return to the Floor, missed while the Owner was
  // away, are left out, so its Agents are in their chairs as it opens.
  useEffect(() => {
    useFloorShown.setState({ floorId, at: Date.now() });
  }, [floorId]);
  const shownAt = useFloorShown((state) =>
    state.floorId === floorId ? state.at : undefined,
  );
  const live = useMemo(
    () =>
      shownAt === undefined
        ? events
        : events.filter(
            ({ occurredAt }) =>
              Date.parse(occurredAt) >= shownAt - replaySlackMs,
          ),
    [events, shownAt],
  );
  const handoffs = useMemo(() => handoffTickets(live), [live]);
  const meetings = useMemo(() => meetingSignals(live), [live]);
  const contractors = useMemo(() => contractorSignals(live), [live]);
  const factFinding = useMemo(() => factFindingVisits(live), [live]);
  // Whether the Floor's team and Grilling Sessions are known: until then a
  // session is not known not to run, and one found running is sat at the
  // table at once rather than walked to.
  const grillingKnown = team !== undefined && sessions !== undefined;
  return floorId === undefined
    ? {
        team: undefined,
        board: undefined,
        handoffs: undefined,
        meetings: undefined,
        contractors: undefined,
        grilling: undefined,
        grillingKnown: false,
        factFinding: undefined,
      }
    : {
        team,
        board,
        handoffs,
        meetings,
        contractors,
        grilling,
        grillingKnown,
        factFinding,
      };
}

/**
 * Keeps the scene's season in step with the seasonal events' settings and
 * the viewer's clock, checked each minute; none once the Office closes.
 */
function useSeasonFeed(): void {
  const { data: settings } = useQuery(seasonalEventsQuery);
  const queryClient = useQueryClient();
  // Changed in General Settings, from any browser: dress up at once.
  useEventStream(
    { types: ["config.changed"] },
    {
      onEvent: ({ event }) => {
        if (
          event.type === "config.changed" &&
          event.keys.includes("seasonalEvents")
        ) {
          void queryClient.invalidateQueries(seasonalEventsQuery);
        }
      },
    },
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const day = now.toDateString();
  useEffect(() => {
    const season =
      settings === undefined ? noSeason : seasonAt(settings, new Date());
    const current = useSeason.getState();
    if (JSON.stringify(current) !== JSON.stringify(season)) {
      useSeason.setState(season, true);
    }
  }, [settings, day]);
  useEffect(
    () => () => {
      useSeason.setState(noSeason, true);
    },
    [],
  );
}

/** A page of a Floor's latest events of some types, newest first. */
const latestEventsQuery = (floorId: string, types: readonly EventType[]) => {
  const filter: EventFilter = { floorId, types };
  return {
    queryKey: ["floor-monitors", floorId, [...types]],
    queryFn: () =>
      getJson(
        eventHistoryUrl(filter, {}, undefined, maxEventHistoryPageSize),
        eventHistoryResponseSchema,
      ),
    // New events come by the stream.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  };
};

/**
 * What each monitor of the Floor the lift is at shows, kept live: its
 * Agents' latest statuses and activity, then each new one as it comes.
 * The statuses are read apart, so a busy Agent's output never hides
 * another's status. Empty in the lobby, and until the Agents load.
 */
function useFloorMonitors(
  floorId: string | undefined,
  team: readonly FloorAgent[] | undefined,
) {
  const enabled = floorId !== undefined;
  const statuses = useQuery({
    ...latestEventsQuery(floorId ?? "", monitorStatusEventTypes),
    enabled,
  });
  const activity = useQuery({
    ...latestEventsQuery(floorId ?? "", monitorActivityEventTypes),
    enabled,
  });
  const backlogs = [statuses, activity];
  // Once both are read (or could not be), resuming after the older of
  // their newest events, so neither misses one; repeats are read once.
  // With none read, it starts from now rather than replay every event.
  const read = backlogs.every(({ isSuccess, isError }) => isSuccess || isError);
  const newest = backlogs.flatMap(({ data }) => data?.events[0]?.id ?? []);
  const after =
    newest.length > 0
      ? Math.min(...newest)
      : backlogs.some(({ isError }) => isError)
        ? undefined
        : 0;
  const { events: streamed } = useEventStream(
    { floorId, types: monitorEventTypes },
    {
      enabled: enabled && read,
      ...(after === undefined ? {} : { after }),
      maxEvents: 1000,
    },
  );
  return useMemo(
    () =>
      monitorScreens(
        (team ?? []).map(({ id }) => id),
        [
          ...(statuses.data?.events ?? []),
          ...(activity.data?.events ?? []),
          ...streamed,
        ],
      ),
    [team, statuses.data, activity.data, streamed],
  );
}

/** The events that change what floats above a Floor's Agents' heads. */
const aboveHeadEventTypes: readonly EventType[] = [
  "agent.context_usage",
  "agent.fresh_start",
];

/**
 * What floats above the heads of the Agents of the Floor the lift is at
 * (FR-62, FR-85), while the scene settings show it: each one's Context
 * Usage, kept live by the Floor's `agent.context_usage` events and read
 * again whenever their stream (re)connects; its tokens today and this
 * month against its caps, read every minute as the Agent card's are; and
 * the Floor's Fresh Starts, which empty their Agents' bars. On a stream of
 * their own, so a busy Agent's Context Usage never pushes the Floor's
 * Handoffs and meetings out of theirs. Undefined in the lobby, and while
 * the settings switch it off.
 */
function useFloorAboveHead(
  floorId: string | undefined,
  team: readonly FloorAgent[] | undefined,
) {
  const shown = useSceneSettings((settings) => settings.showAboveHead);
  const enabled = floorId !== undefined && shown;
  const usageQuery = contextUsageQuery(floorId ?? "");
  const { data: contextUsage, refetch } = useQuery({
    ...usageQuery,
    enabled,
  });
  const { data: tokenUsage } = useQuery({
    ...floorTokenUsageQuery(floorId ?? ""),
    enabled,
    refetchInterval: tokenRefreshMs,
  });
  const { status, events } = useEventStream(
    { floorId, types: aboveHeadEventTypes },
    {
      enabled,
      maxEvents: 50,
      onEvent: ({ event, occurredAt }, client) => {
        if (event.type !== "agent.context_usage") {
          return;
        }
        client.setQueryData(usageQuery.queryKey, (current) =>
          current === undefined
            ? current
            : withContextUsageEvent(current, event, occurredAt),
        );
      },
    },
  );
  useEffect(() => {
    if (status === "open" && enabled) {
      void refetch();
    }
  }, [status, enabled, refetch]);
  const aboveHead = useMemo(
    () =>
      team === undefined
        ? undefined
        : aboveHeads({
            agentIds: team.map(({ id }) => id),
            contextUsage: contextUsage?.agents,
            tokenUsage,
          }),
    [team, contextUsage, tokenUsage],
  );
  const freshStarts = useMemo(() => freshStartSignals(events), [events]);
  return enabled
    ? { aboveHead, freshStarts }
    : { aboveHead: undefined, freshStarts: undefined };
}

/** Closes the open object's panel on Escape. */
function useEscapeCloses(open: boolean) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeInspectable();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
}

/**
 * Keeps the open object in step with where the lift is: a ride closes it
 * (the lift takes the camera), and so does its going from the Floor, such
 * as an Agent removed with its monitor open.
 */
function useCloseWhenGone(
  objects: readonly InspectableObject[],
  known: boolean,
  riding: boolean,
) {
  const selected = useSelectionStore((state) => state.selected);
  useEffect(() => {
    if (riding) {
      closeInspectable({ flyBack: false });
    } else if (
      known &&
      isInspectable(selected) &&
      !objects.some((object) => sameSelection(object, selected))
    ) {
      closeInspectable();
    }
  }, [objects, known, riding, selected]);
}

/** The scene and its panels, fed the Floors and the open Notices. */
function LiveOffice({
  navigate,
  inspect,
  onInspect,
}: {
  navigate?: ((href: string) => void) | undefined;
  inspect?: InspectTarget | undefined;
  onInspect?: ((target: InspectTarget | undefined) => void) | undefined;
}) {
  const quality = useSceneSettings((settings) => settings.quality);
  const showFps = useSceneSettings((settings) => settings.showFps);
  useLiveNotices();
  const { data: floors } = useQuery(floorsQuery);
  const { data: notices } = useQuery(noticesQuery());
  const stops = useMemo(
    () => liftStops(floors ?? [], notices ?? []),
    [floors, notices],
  );
  const location = useLiftStore((state) => liftLocation(state.lift));
  const riding = useLiftStore((state) => isRiding(state.lift));
  const floorId = location.kind === "floor" ? location.floorId : undefined;
  // The board where the lift is: the lobby's Notice Board, with every
  // Floor's Notices, or a Floor's wall board, with its own (FR-50).
  const board = useMemo(
    () =>
      boardPreview(
        (notices ?? []).filter(
          (notice) => floorId === undefined || notice.floorId === floorId,
        ),
      ),
    [notices, floorId],
  );
  const {
    team: listed,
    board: wallBoard,
    handoffs,
    meetings,
    contractors,
    grilling,
    grillingKnown,
    factFinding,
  } = useFloorTeam(floorId);
  // Each desk is dressed as the Role library dresses its Role (FR-57).
  const { data: library } = useQuery({
    ...rolesQuery,
    enabled: floorId !== undefined,
  });
  const team = useMemo(
    () =>
      listed?.map((agent) => ({
        ...agent,
        deskDressing: library?.find(({ id }) => id === agent.role)
          ?.deskDressing,
      })),
    [listed, library],
  );
  const theme = floors?.find(({ id }) => id === floorId)?.theme;
  // The lobby's receptionist, who is the Communications Agent (FR-96), and
  // visitor, and what the receptionist says to the Owner as the Office opens.
  const { data: lobbyCast } = useQuery(lobbyCastQuery);
  useSeasonFeed();
  const { data: communicationsAgent } = useQuery(communicationsAgentQuery);
  const cast = useMemo(
    () =>
      lobbyCast === undefined || communicationsAgent === undefined
        ? undefined
        : {
            ...lobbyCast,
            receptionist: {
              name: communicationsAgent.name,
              avatar: communicationsAgent.avatar,
            },
          },
    [lobbyCast, communicationsAgent],
  );
  // What the Communications Agent sends, and its failing Connections, read
  // again every few seconds in the lobby. Delivery never waits for the
  // envelopes: they only show what was sent.
  const { data: connections } = useQuery({
    ...connectionsQuery,
    enabled: floorId === undefined,
    refetchInterval: receptionRefreshMs,
  });
  const [tally, setTally] = useState(emptyTally);
  const [tallied, setTallied] = useState(connections);
  if (connections !== tallied) {
    setTallied(connections);
    setTally(tallySent(tally, connections));
  }
  const failing = useMemo(() => failingConnections(connections), [connections]);
  const reception = useMemo(
    () =>
      tally.seen === undefined ? undefined : { sent: tally.sent, failing },
    [tally, failing],
  );
  const { data: activitiesOff } = useQuery(floorActivitiesQuery);
  // Whoever signed in: an API key's nickname (else its name) and time
  // zone, or an Owner password's.
  const { data: session } = useQuery(sessionQuery);
  const keyId = session?.gatewayKeyId ?? null;
  const passwordId = session?.passwordId ?? null;
  const { data: keys } = useQuery({
    ...gatewayKeysQuery,
    enabled: keyId !== null,
  });
  const { data: passwords } = useQuery({
    ...ownerPasswordsQuery,
    enabled: session !== undefined && keyId === null,
  });
  const profile = useMemo(() => {
    const signedIn =
      keyId !== null
        ? keys
            ?.filter(({ id }) => id === keyId)
            .map(({ name, profile: { nickname, timeZone } }) => ({
              name,
              nickname,
              timeZone,
            }))[0]
        : passwords?.find(({ id, first }) =>
            passwordId === null ? first : id === passwordId,
          );
    return signedIn === undefined
      ? undefined
      : {
          forename: signedIn.name,
          surname: "",
          nickname: signedIn.nickname,
          timeZone: signedIn.timeZone,
        };
  }, [keyId, keys, passwords, passwordId]);
  const [openedAt] = useState(() => new Date());
  const greeting = useMemo(
    () => (profile === undefined ? undefined : greetingFor(profile, openedAt)),
    [profile, openedAt],
  );
  const monitors = useFloorMonitors(floorId, team);
  const { aboveHead, freshStarts } = useFloorAboveHead(floorId, team);
  const looks = useMemo(
    () =>
      team === undefined
        ? undefined
        : agentLooks({ team, monitors, board: wallBoard }),
    [team, monitors, wallBoard],
  );
  const needsOwner =
    floorId !== undefined && floorNeedsOwner(notices ?? [], floorId);
  // The share of the Floor's Agents at work: how busily its keyboards click.
  const working =
    looks === undefined || looks.size === 0
      ? 0
      : [...looks.values()].filter(({ animation }) => animation === "type")
          .length / looks.size;

  // A Floor archived while it is shown is no longer a stop: back to the lobby.
  useEffect(() => {
    if (floors !== undefined && stopAt(stops, location) === undefined) {
      useLiftStore.getState().call({ order: 0, location: lobby });
    }
  }, [floors, stops, location]);

  const inSession = grilling !== undefined;
  const inspectables = useMemo(
    () =>
      floorId === undefined
        ? lobbyInspectables(communicationsAgent?.name)
        : floorInspectables(floorId, team ?? [], { grilling: inSession }),
    [floorId, team, inSession, communicationsAgent?.name],
  );
  // Whether every object here is known: on a Floor, once its Agents are.
  const known = floorId === undefined || team !== undefined;
  const selected = useSelectionStore((state) => state.selected);
  const open = inspectables.find((object) => sameSelection(object, selected));
  useEscapeCloses(open !== undefined);
  const managerId = team?.find(({ role }) => role === "manager")?.id;
  const managerObject = inspectables.find(
    ({ kind, id }) => kind === "agent" && id === managerId,
  );
  // The Meeting Room (meeting-room-call.ts): called for this Floor alone,
  // and over once the lift leaves it.
  const meetingCalled = useMeetingRoomCall(
    (state) => floorId !== undefined && state.floorId === floorId,
  );
  const meetingPanelOpen = useMeetingRoomCall((state) => state.panelOpen);
  useEffect(() => {
    const called = useMeetingRoomCall.getState().floorId;
    if (called !== undefined && called !== floorId) {
      useMeetingRoomCall.getState().end();
    }
  }, [floorId]);
  // The day's Status update (FR-23a), once the lift is at the Floor and its
  // team is shown, so the Floor walks to the meeting room as it is given.
  useDailyStatusUpdate(floorId, !riding && managerId !== undefined);
  // Those given by themselves, such as each hour while the Agents work.
  useGivenStatusUpdates(floorId);
  // Not over the chat it opens.
  const chatOpen =
    open?.kind === "grilling-session" ||
    (open?.kind === "agent" && open.id === managerId);
  useCloseWhenGone(inspectables, known, riding);

  // An object the address names: ride to its Floor, then open it once it
  // is there. Until then, what opens and closes on the way is not told.
  const pending = useRef<InspectTarget | undefined>(undefined);
  const asked = useRef<string | undefined>(undefined);
  const inspectKey =
    inspect === undefined
      ? undefined
      : JSON.stringify([inspect.location, inspect.kind, inspect.id]);
  useEffect(() => {
    // Only a new address counts, not the same one again.
    if (inspectKey !== asked.current) {
      asked.current = inspectKey;
      pending.current = inspect;
    }
    const target = pending.current;
    if (target === undefined || riding || floors === undefined) {
      return;
    }
    if (!sameLocation(target.location, location)) {
      const stop = stopAt(stops, target.location);
      if (stop === undefined) {
        pending.current = undefined;
      } else {
        useLiftStore
          .getState()
          .call({ order: stop.order, location: stop.location });
      }
      return;
    }
    const object = inspectables.find((each) => sameSelection(each, target));
    if (object !== undefined) {
      openInspectable(object);
    }
    if (object !== undefined || known) {
      pending.current = undefined;
    }
  }, [
    inspect,
    inspectKey,
    riding,
    floors,
    stops,
    location,
    inspectables,
    known,
  ]);

  // Tell the address what opens and closes.
  useEffect(
    () =>
      useSelectionStore.subscribe((state, previous) => {
        const now = isInspectable(state.selected) ? state.selected : undefined;
        const before = isInspectable(previous.selected)
          ? previous.selected
          : undefined;
        if (pending.current !== undefined || sameSelection(now, before)) {
          return;
        }
        onInspect?.(
          now === undefined
            ? undefined
            : {
                kind: now.kind,
                id: now.id,
                location: liftLocation(useLiftStore.getState().lift),
              },
        );
      }),
    [onInspect],
  );

  return (
    <>
      <OfficeSound floorId={floorId} working={working} />
      <SceneBoundary>
        <Suspense
          fallback={
            <SceneMessage>
              <Spinner className="mr-2 inline size-4 align-[-3px]" />
              Loading the Office…
            </SceneMessage>
          }
        >
          <OfficeScene
            quality={quality}
            showFps={showFps}
            board={board}
            stops={stops}
            theme={theme}
            team={team}
            monitors={monitors}
            looks={looks}
            needsOwner={needsOwner}
            handoffs={handoffs}
            meetings={meetings}
            contractors={contractors}
            grilling={grilling}
            grillingKnown={grillingKnown}
            factFinding={factFinding}
            disabledActivities={
              floorId === undefined ? undefined : activitiesOff?.[floorId]
            }
            inspectables={inspectables}
            cast={cast}
            greeting={greeting}
            reception={reception}
            aboveHead={aboveHead}
            freshStarts={freshStarts}
          />
        </Suspense>
      </SceneBoundary>
      {/* The area an open object's panel moves and resizes in (inspector.tsx). */}
      <div
        data-panel-area=""
        className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3 @container"
      >
        {/* As tall as the view leaves above the buttons, so a panel docked
            here scrolls within it rather than running off its foot. */}
        <div className="flex min-h-0 flex-1 items-start justify-between gap-3 pb-2">
          <div className="flex flex-col items-start gap-2">
            <ViewPicker />
            <FloorPicker stops={stops} />
            <InspectablesList objects={inspectables} />
          </div>
          <div className="flex max-h-full min-h-0 min-w-0 flex-col items-end gap-2">
            <SettingsPanel floorId={floorId} />
            {floorId !== undefined && managerId !== undefined && (
              // At the top, where the other panels open: the top of the
              // view is always on screen, its foot not always.
              <StatusUpdatePanel floorId={floorId} className="min-h-0 shrink" />
            )}
            {floorId !== undefined &&
              meetingCalled &&
              meetingPanelOpen &&
              managerObject !== undefined && (
                <MeetingRoomPanel
                  floorId={floorId}
                  manager={managerObject}
                  session={inspectables.find(
                    ({ kind }) => kind === "grilling-session",
                  )}
                  className="min-h-0 shrink"
                />
              )}
            {open !== undefined && (
              // Beside the controls where there is room for both; across
              // the view, over them, where there is not, as on a tablet
              // held upright.
              <div className="contents @max-[39rem]:absolute @max-[39rem]:inset-3 @max-[39rem]:z-10 @max-[39rem]:flex @max-[39rem]:items-start">
                <InspectorPanel
                  key={`${open.kind}:${open.id}`}
                  object={open}
                  navigate={navigate}
                />
              </div>
            )}
          </div>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>{showFps && <FpsOverlay />}</div>
          {floorId !== undefined && managerId !== undefined && (
            <div className="flex flex-col items-end gap-2">
              <div className="flex flex-wrap items-end justify-end gap-2">
                <ActorCallButton />
                <ReturnToDesksButton floorId={floorId} inSession={inSession} />
                <StatusUpdateButton floorId={floorId} fastForward />
                <MeetingRoomButton floorId={floorId} inSession={inSession} />
                {!chatOpen && (
                  <ManagerChatButton
                    objects={inspectables}
                    managerId={managerId}
                  />
                )}
              </div>
            </div>
          )}
          {location.kind === "lobby" && (
            <div className="flex flex-col items-end gap-2">
              <ActorCallButton />
              <BoardSummary board={board} navigate={navigate} />
            </div>
          )}
          {location.kind === "lobby" && greeting !== undefined && (
            <p role="status" className="sr-only">
              {cast?.receptionist.name ?? "The receptionist"} says: {greeting}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

/** The 3D Office, with its panels over it. */
export function OfficeView({
  navigate,
  inspect,
  onInspect,
}: {
  /** Opens a page of AI Office, such as the Notice Board, without a reload. */
  navigate?: ((href: string) => void) | undefined;
  /** An object to open, from the address: the lift goes to its Floor first. */
  inspect?: InspectTarget | undefined;
  /** Told when an object's panel opens or closes, to keep the address in step. */
  onInspect?: ((target: InspectTarget | undefined) => void) | undefined;
} = {}) {
  return (
    <div className="relative min-h-[28rem] flex-1 overflow-hidden rounded-lg border bg-office-light-sky">
      {webgl.available() ? (
        <LiveOffice
          navigate={navigate}
          inspect={inspect}
          onInspect={onInspect}
        />
      ) : (
        <Unavailable>
          This browser cannot show the 3D Office: it has no WebGL 2.
        </Unavailable>
      )}
    </div>
  );
}
