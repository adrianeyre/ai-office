import { palette } from "@ai-office/shared/palette";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Color, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from "three";

import type { ContractorWalker } from "./contractor-walks.ts";
import { boardMarks, type GrillingBoard } from "./grilling-board.ts";
import {
  grillingPlanner,
  type FactFindingVisit,
  type GrillingWalker,
  type RunningSession,
} from "./grilling-walks.ts";
import { inSessionSign, whiteboard, type FloorLayout } from "./floor-layout.ts";
import type { HandoffWalker } from "./handoff-walks.ts";
import { Instances, tintedPaper, unitBox, type Instance } from "./lobby.tsx";
import { emissiveIntensity } from "./materials.ts";
import type { MeetingWalker } from "./meeting-walks.ts";
import { useSceneSettings } from "./scene-settings.ts";

// A Grilling Session on a Floor (PRD FR-83): while one runs, the Floor
// meets in the meeting room, the Manager and every Agent seated round its
// table (grilling-walks.ts; the Avatars move in desk-agents.tsx), the whiteboard behind it shows the current round's
// questions and the decisions settled so far (grilling-board.ts), and the
// sign over the meeting room's door is lit, saying "In session" in HTML
// over the canvas (no text in the scene, PRD §7). The Agents the Manager
// sends to find facts stand up at the table for a moment (or, if not
// there, visit it and walk back). A session that starts or ends while the
// Floor is shown is walked; one already running is shown with everyone
// seated. With reduced motion no one walks: everyone is at the table while
// the session runs. Nor does anyone walk to a session that was running
// before the Floor's sessions were known: they are seated as it opens.

const sessionKey = (running: RunningSession | undefined) =>
  running === undefined
    ? ""
    : [running.sessionId, running.managerId, ...(running.agentIds ?? [])].join(
        ":",
      );

/** Plays a Floor's Grilling Session as it starts, pauses, resumes and ends. */
export function GrillingWalks({
  walker,
  meetings,
  handoffs,
  comings,
  layout,
  running,
  known = true,
  managerId,
  visits,
}: {
  walker: GrillingWalker;
  /** The Floor's Kickoffs and Wrap-ups: an Agent gathered for one sets off once it is back. */
  meetings: Pick<MeetingWalker, "attending">;
  /** The Floor's Handoff walks: an Agent on one sets off once it is back. */
  handoffs: Pick<HandoffWalker, "poseOf">;
  /** The Floor's Contractors coming and going: one walking in sits down first. */
  comings?: Pick<ContractorWalker, "poseOf"> | undefined;
  layout: Pick<
    FloorLayout,
    "desks" | "waypoints" | "meetingSeats" | "meetingWallSeats"
  >;
  /** The Floor's running session; undefined while none runs, or until known. */
  running: RunningSession | undefined;
  /**
   * Whether the Floor's sessions are known yet: the first session seen
   * once they are is already running, so everyone is put at the table
   * rather than walked there. True when left out.
   */
  known?: boolean | undefined;
  /** The Floor's Manager, who finds facts itself without leaving the table. */
  managerId: string | undefined;
  /** The Floor's fact-finding events, oldest first. */
  visits: readonly FactFindingVisit[];
}) {
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const plan = useMemo(() => grillingPlanner(layout), [layout]);
  const planned = useRef(plan);
  useEffect(() => {
    planned.current = plan;
  });

  const latest = useRef(running);
  useEffect(() => {
    latest.current = running;
  });

  // The first session seen was running already: its Manager is seated.
  const seen = useRef<string | undefined>(undefined);
  const key = sessionKey(running);
  useEffect(() => {
    if (!known) {
      return;
    }
    const first = seen.current === undefined;
    if (seen.current === key) {
      return;
    }
    seen.current = key;
    walker.session(latest.current, planned.current, {
      walk: !first && !useSceneSettings.getState().reducedMotion,
    });
  }, [key, walker, known]);

  const [since] = useState(() => Math.max(0, ...visits.map(({ id }) => id)));
  const received = useRef(since);
  useEffect(() => {
    for (const visit of visits) {
      if (visit.id > received.current) {
        received.current = visit.id;
        if (!reducedMotion) {
          walker.visit(visit, managerId, planned.current);
        }
      }
    }
  }, [visits, walker, managerId, reducedMotion]);

  useFrame((_state, delta) => {
    if (useSceneSettings.getState().reducedMotion) {
      walker.settle();
      return;
    }
    walker.advance(
      delta,
      (agentId) =>
        handoffs.poseOf(agentId) !== undefined ||
        meetings.attending(agentId) ||
        comings?.poseOf(agentId) !== undefined,
    );
  });
  return null;
}

const signMaterial = new MeshBasicMaterial({ name: "in-session-sign/lens" });
signMaterial.color
  .set(palette["state-info"])
  .multiplyScalar(emissiveIntensity.lamp);

/**
 * The lit sign over the meeting room's door, while a session runs, and its
 * words in HTML. Nothing at all while none runs.
 */
export function InSessionSign({
  labelsIn,
}: {
  /** Where the words go in the page; beside the canvas by default. */
  labelsIn?: RefObject<HTMLElement> | undefined;
}) {
  const [x, y, z] = inSessionSign.centre;
  return (
    <group name="in-session-sign">
      <mesh
        name="in-session-sign/lamp"
        position={[...inSessionSign.centre]}
        material={signMaterial}
      >
        <boxGeometry args={[...inSessionSign.size]} />
      </mesh>
      <group position={[x, y, z + inSessionSign.size[2]]}>
        <Html
          center
          zIndexRange={[0, 0]}
          style={{ pointerEvents: "none" }}
          {...(labelsIn === undefined ? {} : { portal: labelsIn })}
        >
          <span
            aria-hidden
            data-in-session
            className="rounded-sm bg-office-ink px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-office-paper uppercase shadow-sm"
          >
            In session
          </span>
        </Html>
      </group>
    </group>
  );
}

/** How far each mark stands off the whiteboard's face: notes, then writing on them. */
const markDepth = { note: 0.003, writing: 0.001 } as const;

/** The marks as instances, in the whiteboard's space. */
export function boardInstances(board: GrillingBoard): Instance[] {
  return boardMarks(board).map(({ centre: [x, y], size: [w, h], token }) => {
    const depth = token === "ink" ? markDepth.writing : markDepth.note;
    // Writing lies on the notes; the notes on the board.
    const off = token === "ink" ? markDepth.note + depth / 2 : depth / 2;
    return {
      matrix: new Matrix4().compose(
        new Vector3(x, y, off + 0.0005),
        new Quaternion(),
        new Vector3(w, h, depth),
      ),
      colour: new Color(palette[token]),
    };
  });
}

/** The whiteboard's face: on the back wall, in front of the board. */
const boardFace = [
  whiteboard.centre[0],
  whiteboard.centre[1],
  whiteboard.centre[2] + 0.04,
] as const;

/** The current round and the decisions, drawn on the meeting room's whiteboard. */
export function GrillingWhiteboardMarks({ board }: { board: GrillingBoard }) {
  const instances = useMemo(() => boardInstances(board), [board]);
  return (
    <group name="grilling-whiteboard" position={[...boardFace]}>
      <Instances
        name="grilling-whiteboard-marks"
        instances={instances}
        geometry={unitBox}
        material={tintedPaper}
      />
    </group>
  );
}
