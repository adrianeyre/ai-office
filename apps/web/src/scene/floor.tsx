import type { FloorTheme, SeasonalActorId } from "@ai-office/shared";
import { palette } from "@ai-office/shared/palette";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  DataTexture,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  Vector3,
} from "three";

import type { AboveHead, FreshStartSignal } from "./above-head.ts";
import { agentLooks, type AgentLook } from "./agent-state.ts";
import { ContractorArrivals, useLeavingTeam } from "./contractor-arrivals.tsx";
import {
  createContractorWalker,
  type ContractorSignal,
} from "./contractor-walks.ts";
import { DeskAgents } from "./desk-agents.tsx";
import { chair, type Rect } from "./desk-set.ts";
import {
  floorLayout,
  floorLogo,
  wallBoard,
  wallPosters,
  type FloorAgent,
} from "./floor-layout.ts";
import type { GrillingBoard } from "./grilling-board.ts";
import {
  GrillingWalks,
  GrillingWhiteboardMarks,
  InSessionSign,
} from "./grilling-room.tsx";
import {
  createGrillingWalker,
  meetingRoomWalks,
  type FactFindingVisit,
} from "./grilling-walks.ts";
import { HandoffWalks } from "./handoff-tickets.tsx";
import { createHandoffWalker, type HandoffTicket } from "./handoff-walks.ts";
import { IdleActivities } from "./idle-activities.tsx";
import { createIdleBehaviours, idleActivities } from "./idle-behaviours.ts";
import { Lift, NoticeBoardCards, StaticPieces, WallLogo } from "./lobby.tsx";
import {
  meetingRoomSessionId,
  useMeetingRoomCall,
} from "./meeting-room-call.ts";
import { MeetingFastForward, MeetingWalks } from "./meeting-room.tsx";
import { createMeetingWalker, type MeetingSignal } from "./meeting-walks.ts";
import { material } from "./materials.ts";
import { mergeModels, useModels, type ModelPlacement } from "./models.ts";
import type { MonitorScreen } from "./monitor-preview.ts";
import { MonitorScreens } from "./monitor-screens.tsx";
import type { BoardPreview } from "./notice-board-preview.ts";
import type { LiftStop } from "./lift-stops.ts";
import { qualityPresets } from "./quality.ts";
import { useSceneSettings } from "./scene-settings.ts";
import { useSeason } from "./season.ts";
import { floorDecor, floorEggSpots, floorTreeSpot } from "./seasonal-decor.ts";
import { createVisitScheduler, SeasonalVisitors } from "./seasonal-visitor.tsx";
import { floorVisit, floorWayBack } from "./seasonal-visits.ts";
import { SeasonalDecor } from "./seasonal-decor.tsx";
import { AgentMarkers, ManagersLight, TicketPiles } from "./state-visuals.tsx";
import { WallPosters } from "./wall-posters.tsx";
import type { FloorPoint } from "./waypoints.ts";

// A Floor in the scene (PRD FR-57), drawn from its layout
// (floor-layout.ts): the pieces merged by material, the asset pack's
// models merged the same way once they have loaded, the soft contact
// shadows of Low, the desks' monitors showing their Agents at work
// (monitor-screens.tsx), the Agents at their desks as their Avatars
// (desk-agents.tsx), what their states look like (state-visuals.tsx: the
// piles of tickets, the markers and the Manager's red light), their
// Handoff walks (handoff-tickets.tsx), the Kickoffs and Wrap-ups that
// gather them in the meeting room (meeting-room.tsx), the Grilling
// Session that sits the Manager at its table (grilling-room.tsx), their idle
// behaviours (idle-activities.tsx), the adventure game posters on its
// walls (wall-posters.tsx), the Contractors walking in from the lift and
// back out to it (contractor-arrivals.tsx; ADR 0004), and the lift.

/** The models placed on a Floor, merged into one mesh per material. */
export function PlacedModels({
  placements,
}: {
  placements: readonly ModelPlacement[];
}) {
  const models = useModels();
  const merged = useMemo(
    () => (models === undefined ? [] : mergeModels(placements, models)),
    [placements, models],
  );
  useEffect(
    () => () => {
      for (const { geometry } of merged) {
        geometry.dispose();
      }
    },
    [merged],
  );
  return (
    <group name="models">
      {merged.map(({ token, surface, geometry }) => (
        <mesh
          key={`${token}/${surface}`}
          name={`${token}/${surface}`}
          geometry={geometry}
          material={material(token, surface)}
          castShadow
          receiveShadow
        />
      ))}
    </group>
  );
}

/** A soft-edged square: opaque in the middle, fading out to its edges. */
function softSquare(size = 32): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const fade = (t: number) => {
    const edge = Math.min(t, 1 - t) / 0.3;
    const clamped = Math.min(Math.max(edge, 0), 1);
    return clamped * clamped * (3 - 2 * clamped);
  };
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const alpha = Math.round(
        255 * fade((column + 0.5) / size) * fade((row + 0.5) / size),
      );
      data.set([alpha, alpha, alpha, alpha], (row * size + column) * 4);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** How far a contact shadow reaches past what casts it: the spec's 30 cm of blur. */
export const contactShadowBlur = 0.3;

/** Just above the carpet and the gym mat, which are 1 cm thick. */
export const contactShadowHeight = 0.015;

/** The spec's contact shadow: `shadow` at 35% opacity. */
const contactShadowMaterial = new MeshBasicMaterial({
  name: "contact-shadow",
  color: palette.shadow,
  alphaMap: softSquare(),
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
});
const floorPlane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/**
 * Baked contact shadows: a soft dark blob under each of `rects`, the desks
 * and chairs on Low, and the Agents on Low and High.
 */
export function ContactShadows({
  rects,
  name = "contact-shadows",
}: {
  rects: readonly Rect[];
  name?: string;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const current = mesh.current;
    if (current === null) {
      return;
    }
    rects.forEach(({ x, z }, index) => {
      current.setMatrixAt(
        index,
        new Matrix4().compose(
          new Vector3(
            (x[0] + x[1]) / 2,
            contactShadowHeight,
            (z[0] + z[1]) / 2,
          ),
          new Quaternion(),
          new Vector3(
            x[1] - x[0] + 2 * contactShadowBlur,
            1,
            z[1] - z[0] + 2 * contactShadowBlur,
          ),
        ),
      );
    });
    current.count = rects.length;
    current.instanceMatrix.needsUpdate = true;
    current.computeBoundingSphere();
  }, [rects]);
  return (
    <instancedMesh
      key={rects.length}
      ref={mesh}
      name={name}
      args={[floorPlane, contactShadowMaterial, Math.max(rects.length, 1)]}
      renderOrder={1}
    />
  );
}

const noAgents: readonly FloorAgent[] = [];
const noMonitors: ReadonlyMap<string, MonitorScreen> = new Map();
const noHandoffs: readonly HandoffTicket[] = [];
const noMeetings: readonly MeetingSignal[] = [];
const noVisits: readonly FactFindingVisit[] = [];
const noContractors: readonly ContractorSignal[] = [];

/** A Floor's running Grilling Session, as the Office shows it (FR-83). */
export interface FloorGrilling {
  readonly sessionId: number;
  /** What its whiteboard shows; undefined until known. */
  readonly board?: GrillingBoard | undefined;
}

const noActivitiesOff: readonly string[] = [];

/** A Floor: its rooms, a desk for each of its Agents, and the lift. */
export function Floor({
  floorId,
  theme,
  team = noAgents,
  monitors = noMonitors,
  looks: given,
  needsOwner = false,
  handoffs = noHandoffs,
  meetings: signals = noMeetings,
  contractors = noContractors,
  grilling,
  grillingKnown = true,
  factFinding = noVisits,
  board,
  stops,
  disabledActivities = noActivitiesOff,
  aboveHead,
  freshStarts,
}: {
  floorId: string;
  /** The 3D theme it is dressed in (FR-57); Development's office until known. */
  theme?: FloorTheme | undefined;
  /** The Floor's Agents, in the order the API lists them. */
  team?: readonly FloorAgent[] | undefined;
  /** What each Agent's monitor shows, by the Agent's id. */
  monitors?: ReadonlyMap<string, MonitorScreen> | undefined;
  /**
   * How each Agent's state looks (FR-62), by its id; without them, from
   * its monitor and its pause alone.
   */
  looks?: ReadonlyMap<string, AgentLook> | undefined;
  /** Whether the Floor has an action Notice: the Manager's red light. */
  needsOwner?: boolean | undefined;
  /**
   * The Floor's Handoffs, oldest first (FR-59): each that arrives while
   * the Floor is shown is walked.
   */
  handoffs?: readonly HandoffTicket[] | undefined;
  /**
   * The Floor's Kickoffs and Wrap-ups, oldest first (FR-60): each that
   * begins while the Floor is shown gathers its Agents.
   */
  meetings?: readonly MeetingSignal[] | undefined;
  /**
   * The Floor's Contractors coming and going, oldest first (ADR 0004): each
   * that comes while the Floor is shown walks in from the lift, or out to it.
   */
  contractors?: readonly ContractorSignal[] | undefined;
  /**
   * The Floor's running Grilling Session (FR-83): its Manager sits at the
   * meeting room's table; undefined while none runs.
   */
  grilling?: FloorGrilling | undefined;
  /** Whether the Floor\'s Grilling Sessions are known yet (true when left out). */
  grillingKnown?: boolean | undefined;
  /**
   * The Floor's fact-finding events, oldest first: each that comes once
   * the Floor is shown has its Agent visit the Manager at the table.
   */
  factFinding?: readonly FactFindingVisit[] | undefined;
  /** The Floor's Notices on its wall board (FR-50); none until known. */
  board?: BoardPreview | undefined;
  stops: readonly LiftStop[];
  /** The idle activities turned off on this Floor, by name. */
  disabledActivities?: readonly string[] | undefined;
  /**
   * What floats above each Agent's head, by its id (FR-62, FR-85): its
   * Context Usage bar and its tokens today; nothing until known.
   */
  aboveHead?: ReadonlyMap<string, AboveHead> | undefined;
  /** The Floor's Fresh Starts, oldest first: each new one empties its Agent's bar. */
  freshStarts?: readonly FreshStartSignal[] | undefined;
}) {
  const comings = useMemo(() => createContractorWalker(floorId), [floorId]);
  // A leaving Contractor keeps its desk until it has walked to the lift.
  const { shown, held, settle } = useLeavingTeam(team, comings);
  const layout = useMemo(() => floorLayout(shown, theme), [shown, theme]);
  const seasonalEvents = useSeason((season) => season.events);
  const nibbles = useSeason((season) => season.nibbles);
  const partyFood = useSeason((season) => season.partyFood);
  const halloweenFood = useSeason((season) => season.halloweenFood);
  const decorations = useSeason((season) => season.decorations);
  const eggs = seasonalEvents.includes("easter") && decorations.eggs;
  const decor = useMemo(
    () =>
      floorDecor(seasonalEvents, layout.bounds, {
        nibbles,
        partyFood,
        halloweenFood,
        choices: decorations,
        ...(eggs ? { eggSpots: floorEggSpots(layout) } : {}),
      }),
    [
      seasonalEvents,
      layout,
      nibbles,
      partyFood,
      halloweenFood,
      decorations,
      eggs,
    ],
  );
  // In season, now and then an actor steps out of the lift and goes round
  // a different way each time, by a few of the Agents and the things to
  // play, the lift's doors opening for it.
  const visits = useMemo(() => createVisitScheduler(), []);
  const liftHeld = useMemo(
    () => () => Math.max(comings.liftDoors(), visits.liftDoors()),
    [comings, visits],
  );
  const planVisit = useMemo(
    () => (actor: SeasonalActorId) =>
      floorVisit(
        layout,
        actor,
        layout.desks
          .map(({ agentId }) => ({ agentId, order: Math.random() }))
          .sort((a, b) => a.order - b.order)
          .map(({ agentId }) => agentId),
        seasonalEvents.includes("christmas") &&
          useSeason.getState().decorations.trees
          ? [...floorTreeSpot]
          : undefined,
        { lines: useSeason.getState().lines[actor] },
      ),
    [layout, seasonalEvents],
  );
  const wayBack = useMemo(
    () => (way: readonly FloorPoint[]) => floorWayBack(layout, way),
    [layout],
  );
  const walker = useMemo(() => createHandoffWalker(floorId), [floorId]);
  const meetings = useMemo(() => createMeetingWalker(floorId), [floorId]);
  const grillingWalker = useMemo(
    () => createGrillingWalker(floorId),
    [floorId],
  );
  // What takes Agents to the meeting room: the session, then the meetings.
  const meetingRoom = useMemo(
    () => meetingRoomWalks(meetings, grillingWalker),
    [meetings, grillingWalker],
  );
  // What takes Agents from their chairs for work: coming or going first.
  const awayOnWork = useMemo(
    () => meetingRoomWalks(meetingRoom, comings),
    [meetingRoom, comings],
  );
  const managerId = team.find(({ role }) => role === "manager")?.id;
  // The Owner called the Floor to the Meeting Room (meeting-room-call.ts).
  const called = useMeetingRoomCall((state) => state.floorId === floorId);
  const running = useMemo(
    () =>
      (grilling === undefined && !called) || managerId === undefined
        ? undefined
        : {
            sessionId: grilling?.sessionId ?? meetingRoomSessionId,
            managerId,
            // Everyone on the Floor gathers, those at work too.
            agentIds: team.map(({ id }) => id).filter((id) => id !== managerId),
          },
    [grilling, called, managerId, team],
  );
  // Another Floor's Agents drop out of it as soon as it moves on.
  // Only the activities the Floor has on; changing them starts afresh.
  const activitiesOff = [...disabledActivities].sort().join("\n");
  const idle = useMemo(
    () =>
      createIdleBehaviours(
        Math.random,
        idleActivities.filter(
          ({ name }) => !activitiesOff.split("\n").includes(name),
        ),
      ),
    [activitiesOff],
  );
  const looks = useMemo(
    () => given ?? agentLooks({ team: shown, monitors, board: undefined }),
    [given, shown, monitors],
  );
  const contactShadows = useSceneSettings(
    (settings) => qualityPresets[settings.quality].contactShadows,
  );
  const agentShadows = useMemo(
    () =>
      layout.desks.map(({ seat: [x, , z] }): Rect => ({
        x: [x - chair.size / 2, x + chair.size / 2],
        z: [z - chair.size / 2, z + chair.size / 2],
      })),
    [layout],
  );
  return (
    <group name={`floor-${floorId}`}>
      <StaticPieces pieces={layout.pieces} />
      <SeasonalDecor decor={decor} />
      <WallLogo
        name="floor-logo"
        position={floorLogo.position}
        size={floorLogo.size}
        rotationY={floorLogo.rotationY}
      />
      <WallPosters posters={wallPosters} />
      <PlacedModels placements={layout.models} />
      {contactShadows.props && <ContactShadows rects={layout.contactShadows} />}
      {contactShadows.agents && (
        <ContactShadows rects={agentShadows} name="agent-contact-shadows" />
      )}
      <HandoffWalks
        key={floorId}
        walker={walker}
        layout={layout}
        handoffs={handoffs}
        inMeeting={meetingRoom.attending}
      />
      <ContractorArrivals
        key={`contractors-${floorId}`}
        walker={comings}
        layout={layout}
        signals={contractors}
        held={held}
        onHeld={settle}
      />
      <MeetingWalks
        key={`meetings-${floorId}`}
        meetings={meetings}
        handoffs={walker}
        grilling={grillingWalker}
        comings={comings}
        layout={layout}
        signals={signals}
      />
      <GrillingWalks
        key={`grilling-${floorId}`}
        walker={grillingWalker}
        meetings={meetings}
        handoffs={walker}
        comings={comings}
        layout={layout}
        running={running}
        known={grillingKnown}
        managerId={managerId}
        visits={factFinding}
      />
      <MeetingFastForward
        key={`fast-forward-${floorId}`}
        meetings={meetings}
        grilling={grillingWalker}
      />
      {grilling !== undefined && <InSessionSign />}
      {grilling?.board !== undefined && (
        <GrillingWhiteboardMarks board={grilling.board} />
      )}
      <IdleActivities
        idle={idle}
        walker={walker}
        meetings={awayOnWork}
        layout={layout}
        looks={looks}
      />
      <MonitorScreens desks={layout.desks} screens={monitors} lights={walker} />
      <DeskAgents
        desks={layout.desks}
        team={shown}
        looks={looks}
        walker={walker}
        idle={idle}
        meetings={awayOnWork}
        aboveHead={aboveHead}
        freshStarts={freshStarts}
      />
      <TicketPiles desks={layout.desks} looks={looks} />
      <AgentMarkers desks={layout.desks} looks={looks} />
      <ManagersLight on={needsOwner} />
      {board !== undefined && (
        <NoticeBoardCards
          preview={board}
          name="wall-board"
          position={wallBoard.centre}
        />
      )}
      <Lift stops={stops} held={liftHeld} />
      <SeasonalVisitors scheduler={visits} plan={planVisit} back={wayBack} />
    </group>
  );
}
