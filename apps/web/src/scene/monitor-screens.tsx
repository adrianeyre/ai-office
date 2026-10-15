import { palette } from "@ai-office/shared/palette";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";

import type { Vec3 } from "./camera-rig.ts";
import { monitor, screenDepth } from "./desk-set.ts";
import { emissiveIntensity } from "./materials.ts";
import {
  screenRows,
  type MonitorScreen,
  type ScreenLine,
} from "./monitor-preview.ts";
import type { QuarterTurns } from "./pieces.ts";
import { useSceneSettings } from "./scene-settings.ts";

// The desks' monitors in the scene (PRD FR-58): each working Agent's
// screens glow in `screen-glow` and show its lines of "writing"
// (monitor-preview.ts), scrolling up as new ones come, and glowing a
// little brighter for a moment at each. Every monitor's display is one
// instance of one mesh, and every line one instance of another, so the
// monitors cost two draw calls however many there are. A monitor whose
// Agent has just been handed a ticket (FR-59) lights up: brighter for a
// moment if it is working, and glowing on its own, fading back to dark,
// if it is not. With reduced motion, new lines are there at once and the
// glow is steady.

/** The display: the screen less its bezel, in metres. */
export const display = {
  bezel: 0.015,
  width: monitor.width - 2 * 0.015,
  height: monitor.height - 2 * 0.015,
  /** Between the display's edge and its writing. */
  padding: 0.025,
} as const;

const writingWidth = display.width - 2 * display.padding;
/** From one line to the next, down the display. */
export const rowPitch = (display.height - 2 * display.padding) / screenRows;
const lineHeight = 0.012;

/** How far in front of the screen's centre the display and its writing are. */
export const screenLayers = {
  display: screenDepth / 2 + 0.001,
  writing: screenDepth / 2 + 0.0025,
} as const;

/**
 * How brightly a working screen glows: the spec's screen emissive, and up
 * to `pulse` brighter as a line comes (within its 1.2 to 2.0).
 */
export const screenGlow = { base: emissiveIntensity.screen, pulse: 0.6 };

/** How quickly a scroll and a pulse settle: the share left after a second is e^-rate. */
const scrollRate = 10;
const pulseRate = 4;
/** Under this, a scroll or a pulse is over. */
const settled = 0.001;

/** What the monitors need of a desk. */
export interface MonitorDesk {
  readonly agentId: string;
  readonly turns: QuarterTurns;
  readonly screenCentres: readonly Vec3[];
}

/** A monitor's motion: how its lines are scrolling, and its glow. */
interface Motion {
  /** The newest line it has shown, and the row it is on once scrolled. */
  readonly lastSeq: number;
  readonly lastRow: number;
  /** How many rows its lines are still below where they will settle. */
  scroll: number;
  /** How much brighter it glows, from 1 as a line comes to 0. */
  pulse: number;
  readonly activity: number;
}

/** The row each of a screen's lines settles on: the newest at the bottom once it is full. */
export const rowOf = (index: number, count: number) =>
  index - Math.max(0, count - screenRows);

/**
 * A monitor's motion after its screen changed: its lines start where they
 * were and scroll up to where they settle, and new activity makes it glow.
 */
export function nextMotion(
  before: Motion | undefined,
  screen: MonitorScreen,
  reducedMotion: boolean,
): Motion {
  const { lines } = screen;
  const newest = lines.at(-1);
  const at = {
    lastSeq: newest?.seq ?? 0,
    lastRow: rowOf(lines.length - 1, lines.length),
    activity: screen.activity,
  };
  if (before === undefined || reducedMotion) {
    return { ...at, scroll: 0, pulse: 0 };
  }
  // The newest line it had before, and where it is now.
  const kept = lines.findLastIndex(({ seq }) => seq <= before.lastSeq);
  const scroll =
    kept >= 0
      ? before.lastRow + before.scroll - rowOf(kept, lines.length)
      : before.lastSeq > 0
        ? // A burst longer than it keeps: a whole screen scrolls in.
          screenRows
        : rowOf(0, lines.length) < 0
          ? lines.length - screenRows
          : 0;
  return {
    ...at,
    scroll: Math.min(Math.max(scroll, 0), screenRows),
    pulse: screen.activity > before.activity ? 1 : before.pulse,
  };
}

const unitBox = new BoxGeometry(1, 1, 1);
/** Instances' colours are the palette's, on white: the screens light themselves. */
const displayMaterial = new MeshBasicMaterial({ name: "monitor-displays" });
const writingMaterial = new MeshBasicMaterial({ name: "monitor-writing" });

const yAxis = new Vector3(0, 1, 0);
const glow = new Color(palette["screen-glow"]);

interface Instance {
  readonly matrix: Matrix4;
  readonly colour: Color;
}

/** A screen's own frame: at its centre, facing its Agent's chair (+z). */
const screenFrame = (centre: Vec3, turns: QuarterTurns) =>
  new Matrix4().compose(
    new Vector3(...centre),
    new Quaternion().setFromAxisAngle(yAxis, (turns * Math.PI) / 2),
    new Vector3(1, 1, 1),
  );

/** A box on a screen, from its centre, `size` across. */
const onScreen = (frame: Matrix4, position: Vec3, size: Vec3) =>
  frame
    .clone()
    .multiply(
      new Matrix4().compose(
        new Vector3(...position),
        new Quaternion(),
        new Vector3(...size),
      ),
    );

/** A line's box on a screen, at `row` (fractional while it scrolls). */
function lineBox(line: ScreenLine, row: number): [Vec3, Vec3] {
  const width = line.width * writingWidth;
  return [
    [
      -writingWidth / 2 + line.indent * writingWidth + width / 2,
      display.height / 2 - display.padding - (row + 0.5) * rowPitch,
      screenLayers.writing,
    ],
    [width, lineHeight, 0.001],
  ];
}

/** How lit each monitor is by a ticket just handed to its Agent, 0 to 1. */
export interface MonitorLights {
  readonly light: (agentId: string) => number;
  /** Whether any monitor is lit. */
  readonly lit: () => boolean;
}

/**
 * How brightly a monitor's display glows: a working one at the spec's
 * screen emissive, brighter for a moment at each new line or ticket; an
 * idle one lit by a ticket at its brightest, fading as its light does;
 * otherwise none.
 */
export function displayBrightness(
  working: boolean,
  pulse: number,
  light: number,
): number {
  if (working) {
    return screenGlow.base + screenGlow.pulse * Math.max(pulse, light);
  }
  return (screenGlow.base + screenGlow.pulse) * light;
}

/**
 * The monitors' instances, in world space: a glowing display on each
 * working Agent's screens, and on each its lines that are on the display;
 * and a glowing display on each idle one lit by a ticket handed to it.
 */
export function monitorInstances(
  desks: readonly MonitorDesk[],
  screens: ReadonlyMap<string, MonitorScreen>,
  motions: ReadonlyMap<string, Pick<Motion, "scroll" | "pulse">> = new Map(),
  light: (agentId: string) => number = () => 0,
): { displays: Instance[]; writing: Instance[] } {
  const displays: Instance[] = [];
  const writing: Instance[] = [];
  for (const { agentId, turns, screenCentres } of desks) {
    const screen = screens.get(agentId);
    const working = screen?.working === true;
    const lit = light(agentId);
    if (!working && lit <= 0) {
      continue;
    }
    const { scroll = 0, pulse = 0 } = motions.get(agentId) ?? {};
    const brightness = displayBrightness(working, pulse, lit);
    for (const centre of screenCentres) {
      const frame = screenFrame(centre, turns);
      displays.push({
        matrix: onScreen(
          frame,
          [0, 0, screenLayers.display],
          [display.width, display.height, 0.001],
        ),
        colour: glow.clone().multiplyScalar(brightness),
      });
      if (screen === undefined || !working) {
        continue;
      }
      screen.lines.forEach((line, index) => {
        const row = rowOf(index, screen.lines.length) + scroll;
        if (line.width === 0 || row < -0.5 || row > screenRows - 0.5) {
          return;
        }
        const [position, size] = lineBox(line, row);
        writing.push({
          matrix: onScreen(frame, position, size),
          colour: new Color(palette[line.token]),
        });
      });
    }
  }
  return { displays, writing };
}

/** Room for a few more than needed, so a new line rarely makes a new mesh. */
const capacityFor = (count: number) => Math.max(8, Math.ceil(count / 8) * 8);

/** Writes instances into a mesh made with room for them. */
function setInstances(mesh: InstancedMesh | null, instances: Instance[]) {
  if (mesh === null) {
    return;
  }
  instances.forEach(({ matrix, colour }, index) => {
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, colour);
  });
  mesh.count = instances.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) {
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.computeBoundingSphere();
}

/** Draws the monitors' instances into their two meshes. */
function drawMonitors(
  displays: InstancedMesh | null,
  writing: InstancedMesh | null,
  desks: readonly MonitorDesk[],
  screens: ReadonlyMap<string, MonitorScreen>,
  motions: ReadonlyMap<string, Motion>,
  lights: MonitorLights | undefined,
) {
  // With reduced motion a lit monitor holds its glow, and then goes dark.
  const reducedMotion = useSceneSettings.getState().reducedMotion;
  const instances = monitorInstances(desks, screens, motions, (agentId) => {
    const light = lights?.light(agentId) ?? 0;
    return reducedMotion && light > 0 ? 1 : light;
  });
  setInstances(displays, instances.displays);
  setInstances(writing, instances.writing);
}

/** The monitors on a Floor's desks, showing their Agents' activity live. */
export function MonitorScreens({
  desks,
  screens,
  lights,
}: {
  desks: readonly MonitorDesk[];
  /** Each Agent's monitor, by its id; an Agent with none shows nothing. */
  screens: ReadonlyMap<string, MonitorScreen>;
  /** Monitors lit up by a ticket handed to their Agents (FR-59). */
  lights?: MonitorLights | undefined;
}) {
  const displays = useRef<InstancedMesh>(null);
  const writing = useRef<InstancedMesh>(null);
  const motions = useRef(new Map<string, Motion>());
  const screenCount = desks.reduce(
    (sum, { screenCentres }) => sum + screenCentres.length,
    0,
  );

  // A new screen, or a desk added or taken away: where each monitor's
  // lines start from, then draw them there.
  useLayoutEffect(() => {
    const { reducedMotion } = useSceneSettings.getState();
    const next = new Map<string, Motion>();
    for (const { agentId } of desks) {
      const screen = screens.get(agentId);
      if (screen?.working === true) {
        next.set(
          agentId,
          nextMotion(motions.current.get(agentId), screen, reducedMotion),
        );
      }
    }
    motions.current = next;
    drawMonitors(
      displays.current,
      writing.current,
      desks,
      screens,
      next,
      lights,
    );
  }, [desks, screens, lights]);

  const wasLit = useRef(false);

  useFrame((_state, delta) => {
    const reducedMotion = useSceneSettings.getState().reducedMotion;
    let moving = false;
    for (const motion of motions.current.values()) {
      if (motion.scroll === 0 && motion.pulse === 0) {
        continue;
      }
      moving = true;
      const settle = (value: number, rate: number) => {
        const left = reducedMotion ? 0 : value * Math.exp(-rate * delta);
        return left < settled ? 0 : left;
      };
      motion.scroll = settle(motion.scroll, scrollRate);
      motion.pulse = settle(motion.pulse, pulseRate);
    }
    // Lit by a ticket, or just gone dark: drawn again too.
    const lit = lights?.lit() ?? false;
    if (moving || lit || wasLit.current) {
      drawMonitors(
        displays.current,
        writing.current,
        desks,
        screens,
        motions.current,
        lights,
      );
    }
    wasLit.current = lit;
  });

  const displayCapacity = capacityFor(screenCount);
  const writingCapacity = capacityFor(screenCount * (screenRows + 1));
  return (
    <group name="monitor-screens">
      <instancedMesh
        key={`displays-${String(displayCapacity)}`}
        ref={displays}
        name="monitor-displays"
        args={[unitBox, displayMaterial, displayCapacity]}
      />
      <instancedMesh
        key={`writing-${String(writingCapacity)}`}
        ref={writing}
        name="monitor-writing"
        args={[unitBox, writingMaterial, writingCapacity]}
      />
    </group>
  );
}
