import type { FloorTheme, LobbyCast } from "@ai-office/shared";

import type { AboveHead, FreshStartSignal } from "./above-head.ts";
import type { AgentLook } from "./agent-state.ts";
import { Floor } from "./floor.tsx";
import type { FloorAgent } from "./floor-layout.ts";
import type { HandoffTicket } from "./handoff-walks.ts";
import type { FloorGrilling } from "./floor.tsx";
import type { FactFindingVisit } from "./grilling-walks.ts";
import type { MeetingSignal } from "./meeting-walks.ts";
import type { ContractorSignal } from "./contractor-walks.ts";
import type { InspectableObject } from "./inspectable.ts";
import { InspectableHotspots } from "./inspectable-hotspots.tsx";
import { liftLocation } from "./lift.ts";
import { useLiftStore } from "./lift-store.ts";
import type { LiftStop } from "./lift-stops.ts";
import { Lobby } from "./lobby.tsx";
import type { MonitorScreen } from "./monitor-preview.ts";
import type { BoardPreview } from "./notice-board-preview.ts";
import type { Reception } from "./reception-desk.tsx";

// The place the lift is at, in the scene: the lobby, or a Floor with a desk
// for each of its Agents and their monitors, what their states look like,
// what floats above their heads, their Handoff walks, and the objects there
// that can be inspected.

/** The place the lift is at: the lobby, or a Floor. */
export function OfficeLocationScene({
  board,
  stops,
  theme,
  team,
  monitors,
  looks,
  needsOwner,
  handoffs,
  meetings,
  contractors,
  grilling,
  grillingKnown = true,
  factFinding,
  disabledActivities,
  inspectables = [],
  cast,
  greeting,
  reception,
  aboveHead,
  freshStarts,
}: {
  /** The idle activities turned off on the Floor shown, by name. */
  disabledActivities?: readonly string[] | undefined;
  /** What the lobby's Notice Board, or the Floor's wall board, shows. */
  board: BoardPreview;
  stops: readonly LiftStop[];
  /** The Floor's 3D theme (FR-57); Development's office until known. */
  theme?: FloorTheme | undefined;
  /** The Agents of the Floor shown; none until they have loaded. */
  team?: readonly FloorAgent[] | undefined;
  /** What each of the Floor's monitors shows, by its Agent's id. */
  monitors?: ReadonlyMap<string, MonitorScreen> | undefined;
  /** How each of the Floor's Agents' states looks, by its id (FR-62). */
  looks?: ReadonlyMap<string, AgentLook> | undefined;
  /** Whether the Floor has an action Notice: the Manager's red light. */
  needsOwner?: boolean | undefined;
  /** The Floor's Handoffs, oldest first: each new one is walked (FR-59). */
  handoffs?: readonly HandoffTicket[] | undefined;
  /** That Floor's Kickoffs and Wrap-ups, oldest first (FR-60). */
  meetings?: readonly MeetingSignal[] | undefined;
  /** The Floor's Contractors coming and going, oldest first (ADR 0004). */
  contractors?: readonly ContractorSignal[] | undefined;
  /** That Floor's running Grilling Session, if one runs (FR-83). */
  grilling?: FloorGrilling | undefined;
  /** Whether the Floor\'s Grilling Sessions are known yet (true when left out). */
  grillingKnown?: boolean | undefined;
  /** That Floor's fact-finding events, oldest first: each new one is a visit to the Manager. */
  factFinding?: readonly FactFindingVisit[] | undefined;
  /** The objects that can be inspected where the lift is. */
  inspectables?: readonly InspectableObject[];
  /** The lobby's receptionist (the Communications Agent) and visitor; none until they load. */
  cast?: LobbyCast | undefined;
  /** What the receptionist says to the Owner as the Office opens. */
  greeting?: string | undefined;
  /** What the lobby's reception desk shows; nothing until the Connections are read. */
  reception?: Reception | undefined;
  /** What floats above each of the Floor's Agents' heads, by its id (FR-62, FR-85). */
  aboveHead?: ReadonlyMap<string, AboveHead> | undefined;
  /** The Floor's Fresh Starts, oldest first: each new one empties its Agent's bar. */
  freshStarts?: readonly FreshStartSignal[] | undefined;
}) {
  const location = useLiftStore((state) => liftLocation(state.lift));
  return (
    <>
      {location.kind === "lobby" ? (
        <Lobby
          board={board}
          stops={stops}
          cast={cast}
          greeting={greeting}
          reception={reception}
        />
      ) : (
        <Floor
          floorId={location.floorId}
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
          disabledActivities={disabledActivities}
          board={board}
          stops={stops}
          aboveHead={aboveHead}
          freshStarts={freshStarts}
        />
      )}
      <InspectableHotspots objects={inspectables} />
    </>
  );
}
