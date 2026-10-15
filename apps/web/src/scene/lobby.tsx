import type { LobbyCast, SeasonalActorId } from "@ai-office/shared";
import { palette } from "@ai-office/shared/palette";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type Mesh,
} from "three";

import { brand } from "@/brand/brand.ts";

import type { Vec3 } from "./camera-rig.ts";
import {
  liftCallButton,
  liftDoor,
  liftDoorway,
  liftLamps,
  liftSign,
} from "./lift-layout.ts";
import { shownDoors, useLiftStore } from "./lift-store.ts";
import { stopAt, type LiftStop } from "./lift-stops.ts";
import { liftLocation } from "./lift.ts";
import {
  lobbyPieces,
  noticeBoardPosition,
  receptionLogo,
} from "./lobby-layout.ts";
import { LobbyPeople } from "./lobby-people.tsx";
import { ReceptionDesk, type Reception } from "./reception-desk.tsx";
import { emissiveIntensity, material, surfaces } from "./materials.ts";
import {
  cardSize,
  type BoardCard,
  type BoardPreview,
} from "./notice-board-preview.ts";
import { mergePieces } from "./piece-geometry.ts";
import type { Piece } from "./pieces.ts";
import { useSceneSettings } from "./scene-settings.ts";
import { useSeason } from "./season.ts";
import { lobbyDecor, lobbyTreeSpot } from "./seasonal-decor.ts";
import { createVisitScheduler, SeasonalVisitors } from "./seasonal-visitor.tsx";
import { lobbyVisit } from "./seasonal-visits.ts";
import { SeasonalDecor } from "./seasonal-decor.tsx";
import { tapSlop } from "./touch-camera.ts";

// The lobby in the scene (PRD FR-57): its pieces, the cards on its Notice
// Board, the Communications Agent's reception desk (FR-96) and the lift,
// which every Floor has too (floor.tsx).

/** Pieces merged into one mesh per material, so a room costs few draw calls. */
export function StaticPieces({ pieces }: { pieces: readonly Piece[] }) {
  const merged = useMemo(() => mergePieces(pieces), [pieces]);
  useEffect(
    () => () => {
      for (const { geometry } of merged) {
        geometry.dispose();
      }
    },
    [merged],
  );
  return (
    <group name="pieces">
      {merged.map(({ token, surface, castShadow, geometry }) => (
        <mesh
          key={`${token}/${surface}/${String(castShadow)}`}
          name={`${token}/${surface}`}
          geometry={geometry}
          material={material(token, surface)}
          castShadow={castShadow}
          receiveShadow
        />
      ))}
    </group>
  );
}

// One unit box and one pin, shared by every instance and scaled by its matrix.
export const unitBox = new BoxGeometry(1, 1, 1);
const pinGeometry = new SphereGeometry(0.5, 8, 6);

/** Instances' tints multiply a white material: the palette colour is the tint. */
export const tintedPaper = new MeshStandardMaterial({
  name: "board-cards/paint",
  color: "#ffffff",
  ...surfaces.paint,
});
const tintedPlastic = new MeshStandardMaterial({
  name: "board-pins/plastic",
  color: "#ffffff",
  ...surfaces.plastic,
});

/**
 * How far from the wall the middle of each layer on the board is, in
 * metres: the felt's face, the stacked sheets, the cards, their writing and
 * their pins.
 */
export const boardLayers = {
  felt: 0.02,
  sheet: 0.022,
  card: 0.03,
  writing: 0.0325,
  pin: 0.036,
} as const;
const layer = boardLayers;
const writingWidth = cardSize.width - 0.1;

const zAxis = new Vector3(0, 0, 1);

/** A card's own frame on the board: where it is and how it is turned. */
function cardFrame(card: Pick<BoardCard, "position" | "tilt">): Matrix4 {
  return new Matrix4().compose(
    new Vector3(card.position[0], card.position[1], 0),
    new Quaternion().setFromAxisAngle(zAxis, card.tilt),
    new Vector3(1, 1, 1),
  );
}

/** A box on a card, from the card's centre, `size` across. */
const onCard = (
  frame: Matrix4,
  [x, y, z]: readonly [number, number, number],
  size: readonly [number, number, number],
) =>
  frame
    .clone()
    .multiply(
      new Matrix4().compose(
        new Vector3(x, y, z),
        new Quaternion(),
        new Vector3(...size),
      ),
    );

export interface Instance {
  readonly matrix: Matrix4;
  readonly colour: Color;
}

/** The board's instances, in board space: sheets, writing and pins. */
export function boardInstances(preview: BoardPreview): {
  sheets: Instance[];
  writing: Instance[];
  pins: Instance[];
} {
  const paper = new Color(palette.paper);
  const ink = new Color(palette.ink);
  const sheets: Instance[] = [];
  const writing: Instance[] = [];
  const pins: Instance[] = [];
  const last = preview.cards.at(-1);
  // The hidden Notices are a stack of sheets peeking out from under the last card.
  for (let sheet = preview.stackedSheets; sheet >= 1 && last; sheet -= 1) {
    const frame = cardFrame({
      position: [
        last.position[0] + 0.018 * sheet,
        last.position[1] - 0.014 * sheet,
      ],
      tilt: last.tilt + 0.03 * sheet,
    });
    sheets.push({
      matrix: onCard(
        frame,
        [0, 0, layer.sheet + 0.0025 * (3 - sheet)],
        [cardSize.width, cardSize.height, 0.002],
      ),
      colour: paper,
    });
  }
  for (const card of preview.cards) {
    const frame = cardFrame(card);
    const kind = new Color(palette[card.token]);
    sheets.push({
      matrix: onCard(
        frame,
        [0, 0, layer.card],
        [cardSize.width, cardSize.height, 0.004],
      ),
      colour: paper,
    });
    // The stripe along the top, in the kind's colour.
    writing.push({
      matrix: onCard(
        frame,
        [0, cardSize.height / 2 - 0.03, layer.writing],
        [cardSize.width - 0.02, 0.03, 0.001],
      ),
      colour: kind,
    });
    card.lines.forEach((share, index) => {
      const width = share * writingWidth;
      writing.push({
        matrix: onCard(
          frame,
          [-writingWidth / 2 + width / 2, 0.04 - index * 0.05, layer.writing],
          [width, 0.014, 0.001],
        ),
        colour: ink,
      });
    });
    for (const [x, y] of card.pins) {
      pins.push({
        matrix: onCard(frame, [x, y, layer.pin], [0.024, 0.024, 0.024]),
        colour: kind,
      });
    }
  }
  return { sheets, writing, pins };
}

/** Instances of one geometry and material, set from a list. */
export function Instances({
  name,
  instances,
  geometry,
  material: instanceMaterial,
  castShadow = false,
}: {
  name: string;
  instances: readonly Instance[];
  geometry: BoxGeometry | SphereGeometry;
  material: MeshStandardMaterial | MeshBasicMaterial;
  castShadow?: boolean;
}) {
  const mesh = useRef<InstancedMesh>(null);
  // Room for a few more than needed, so a new Notice rarely makes a new mesh.
  const capacity = Math.max(8, Math.ceil(instances.length / 8) * 8);
  useLayoutEffect(() => {
    const current = mesh.current;
    if (current === null) {
      return;
    }
    instances.forEach(({ matrix, colour }, index) => {
      current.setMatrixAt(index, matrix);
      current.setColorAt(index, colour);
    });
    current.count = instances.length;
    current.instanceMatrix.needsUpdate = true;
    if (current.instanceColor !== null) {
      current.instanceColor.needsUpdate = true;
    }
    current.computeBoundingSphere();
  }, [instances]);
  return (
    <instancedMesh
      key={capacity}
      ref={mesh}
      name={name}
      args={[geometry, instanceMaterial, capacity]}
      castShadow={castShadow}
      receiveShadow
    />
  );
}

/**
 * The cards on a board: a stylised preview of the latest Notices. The
 * lobby's Notice Board is the default; a Floor's wall board names itself
 * and its centre on the wall.
 */
export function NoticeBoardCards({
  preview,
  name = "notice-board",
  position = noticeBoardPosition,
}: {
  preview: BoardPreview;
  name?: string;
  /** The board's centre on the wall's face, in metres. */
  position?: Vec3;
}) {
  const { sheets, writing, pins } = useMemo(
    () => boardInstances(preview),
    [preview],
  );
  return (
    <group name={name} position={[...position]}>
      <Instances
        name={`${name}-sheets`}
        instances={sheets}
        geometry={unitBox}
        material={tintedPaper}
      />
      <Instances
        name={`${name}-writing`}
        instances={writing}
        geometry={unitBox}
        material={tintedPaper}
      />
      <Instances
        name={`${name}-pins`}
        instances={pins}
        geometry={pinGeometry}
        material={tintedPlastic}
      />
    </group>
  );
}

/** Lamps glow in their token, brighter than white, so they bloom. */
const glowMaterial = new MeshBasicMaterial({ name: "lift-lamps/glow" });
const glow = (token: "lamp" | "state-critical") =>
  new Color(palette[token]).multiplyScalar(emissiveIntensity.lamp);
const lampOff = new Color(palette["screen-off"]);

/** Where a stop's lamp is, over the doors. */
function lampPosition(index: number, shown: number): Vector3 {
  return new Vector3(
    liftDoorway.position[0] + (index - (shown - 1) / 2) * liftLamps.spacing,
    liftLamps.height,
    liftDoorway.position[2] + 0.01,
  );
}

const lampMatrix = (
  index: number,
  shown: number,
  size: readonly number[],
  y?: number,
) => {
  const position = lampPosition(index, shown);
  if (y !== undefined) {
    position.y = y;
  }
  return new Matrix4().compose(
    position,
    new Quaternion(),
    new Vector3(size[0], size[1], size[2]),
  );
};

/** Opens the floor picker, from a click on the doors. */
function openPicker(event: ThreeEvent<MouseEvent>) {
  event.stopPropagation();
  // A drag that moved the camera (by touch) is not a click.
  if (event.delta > tapSlop) {
    return;
  }
  useLiftStore.getState().setPickerOpen(true);
}

/** Calls the lift, from a click on its call button: the doors open, then the picker. */
function callLift(event: ThreeEvent<MouseEvent>) {
  event.stopPropagation();
  if (event.delta > tapSlop) {
    return;
  }
  useLiftStore.getState().press(useSceneSettings.getState().reducedMotion);
}

/** The call button lit brighter while a call is answered. */
const pressedMaterial = new MeshBasicMaterial({
  name: "lift-call-button/pressed",
  color: glow("lamp"),
});

/**
 * Round the call button, unseen: a bigger target than the button itself,
 * so it is easy to click from across the room.
 */
const callTargetMaterial = new MeshBasicMaterial({
  name: "lift-call-target",
  transparent: true,
  opacity: 0,
  depthWrite: false,
});

function pointAt(event: ThreeEvent<PointerEvent>) {
  event.stopPropagation();
  document.body.style.cursor = "pointer";
}

function stopPointing() {
  document.body.style.cursor = "";
}

/** One of the lift's sliding doors; `Lift` moves it each frame. */
function LiftDoor({ ref, side }: { ref: Ref<Mesh>; side: "left" | "right" }) {
  return (
    <mesh
      ref={ref}
      name={`lift-door-${side}`}
      position={[
        liftDoorway.position[0],
        liftDoor.size[1] / 2,
        liftDoorway.position[2],
      ]}
      material={material("metal-dark", "metal")}
      castShadow
      receiveShadow
      onClick={openPicker}
      onPointerOver={pointAt}
      onPointerOut={stopPointing}
    >
      <boxGeometry args={[...liftDoor.size]} />
    </mesh>
  );
}

/**
 * The lift's moving parts: the doors, a lamp over them for each stop (the
 * car's lit, and a red marker under a stop with an action Notice), and
 * the lit call button. Clicking the doors opens the floor picker; clicking
 * the button calls the lift: it lights, the doors open, then the picker.
 */
export function Lift({
  stops,
  held,
}: {
  stops: readonly LiftStop[];
  /**
   * How open someone walking through holds the doors, 0 to 1: a Contractor
   * stepping out of the lift or into it (ADR 0004). Shut by default.
   */
  held?: (() => number) | undefined;
}) {
  const left = useRef<Mesh>(null);
  const right = useRef<Mesh>(null);
  const lamps = useRef<InstancedMesh>(null);
  const shown = useMemo(() => stops.slice(0, liftLamps.max), [stops]);
  const lit = useRef<number>(undefined);

  const markers = useMemo(
    () =>
      shown.flatMap((stop, index) =>
        stop.actionNotices > 0
          ? [
              {
                matrix: lampMatrix(
                  index,
                  shown.length,
                  liftLamps.markerSize,
                  liftLamps.markerHeight,
                ),
                colour: glow("state-critical"),
              },
            ]
          : [],
      ),
    [shown],
  );

  useLayoutEffect(() => {
    lit.current = undefined;
    const mesh = lamps.current;
    if (mesh === null) {
      return;
    }
    shown.forEach((_stop, index) => {
      mesh.setMatrixAt(index, lampMatrix(index, shown.length, liftLamps.size));
    });
    mesh.count = shown.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [shown]);

  const pressed = useLiftStore((state) => state.answering !== undefined);
  useFrame(() => {
    const state = useLiftStore.getState();
    const { lift } = state;
    const [doorX, , doorZ] = liftDoorway.position;
    const open =
      Math.max(1 - shownDoors(state), held?.() ?? 0) * liftDoor.travel;
    const closedOffset = liftDoor.size[0] / 2;
    left.current?.position.setX(doorX - closedOffset - open);
    right.current?.position.setX(doorX + closedOffset + open);
    left.current?.position.setZ(doorZ - 0.05);
    right.current?.position.setZ(doorZ - 0.05);

    const mesh = lamps.current;
    const at = Math.round(lift.car);
    if (mesh !== null && lit.current !== at) {
      lit.current = at;
      shown.forEach((stop, index) => {
        mesh.setColorAt(index, stop.order === at ? glow("lamp") : lampOff);
      });
      if (mesh.instanceColor !== null) {
        mesh.instanceColor.needsUpdate = true;
      }
    }
  });

  return (
    <group name="lift">
      <LiftDoor ref={left} side="left" />
      <LiftDoor ref={right} side="right" />
      <instancedMesh
        key={`lamps-${String(liftLamps.max)}`}
        ref={lamps}
        name="lift-lamps"
        args={[unitBox, glowMaterial, liftLamps.max]}
      />
      <Instances
        name="lift-markers"
        instances={markers}
        geometry={unitBox}
        material={glowMaterial}
      />
      <LiftSign stops={stops} />
      <mesh
        name="lift-call-button"
        position={[...liftCallButton.position]}
        material={pressed ? pressedMaterial : material("lamp", "lamp")}
        onClick={callLift}
        onPointerOver={pointAt}
        onPointerOut={stopPointing}
      >
        <boxGeometry args={[...liftCallButton.size]} />
      </mesh>
      <mesh
        name="lift-call-target"
        position={[
          liftCallButton.position[0],
          liftCallButton.position[1],
          liftCallButton.position[2] + 0.02,
        ]}
        material={callTargetMaterial}
        onClick={callLift}
        onPointerOver={pointAt}
        onPointerOut={stopPointing}
      >
        <boxGeometry args={[0.24, 0.3, 0.02]} />
      </mesh>
    </group>
  );
}

/** How many pixels across the lift's sign is drawn, so it stays crisp close up. */
const signPixels = 2048;

/**
 * The sign's lettering as a texture: `text` in bold paper, or lamp at
 * night, on clear, shrunk to fit. Never blurred: at night the Bloom alone
 * makes it glow, a little, so it is still read from across the Floor.
 * Undefined where canvases cannot draw (jsdom).
 */
function useSignTexture(text: string, lit: boolean): CanvasTexture | undefined {
  const [width, height] = liftSign.size;
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = signPixels;
    canvas.height = Math.round((signPixels * height) / width);
    const context = canvas.getContext("2d");
    if (context === null) {
      return undefined;
    }
    const room = canvas.width * 0.92;
    let size = canvas.height * 0.68;
    const font = (px: number) =>
      `700 ${String(px)}px "Inter Variable", system-ui, sans-serif`;
    context.font = font(size);
    const measured = context.measureText(text).width;
    if (measured > room) {
      size *= room / measured;
      context.font = font(size);
    }
    context.fillStyle = lit ? palette.lamp : palette.paper;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    const made = new CanvasTexture(canvas);
    made.colorSpace = SRGBColorSpace;
    made.anisotropy = 16;
    return made;
  }, [text, lit, width, height]);
  useEffect(
    () => () => {
      texture?.dispose();
    },
    [texture],
  );
  return texture;
}

/** Whether it is night by the viewer's clock, 19:00 to 07:00. */
export const isNight = (at: Date): boolean =>
  at.getHours() >= 19 || at.getHours() < 7;

/** Whether it is night now, checked each minute. */
function useNight(): boolean {
  const [night, setNight] = useState(() => isNight(new Date()));
  useEffect(() => {
    const timer = setInterval(() => {
      setNight(isNight(new Date()));
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return night;
}

/**
 * How much brighter than drawn the sign shows at night: just past the
 * Bloom's threshold, so it glows without its letters running together.
 */
const nightGlow = 1.2;

/**
 * The sign over the lift's lamps naming where it is: "Lobby", or the
 * Floor's name as the Owner gave it, renamed as it is renamed. At night
 * its lettering is lit, and glows.
 */
function LiftSign({ stops }: { stops: readonly LiftStop[] }) {
  const location = useLiftStore((state) => liftLocation(state.lift));
  const name = stopAt(stops, location)?.name ?? "";
  const night = useNight();
  const texture = useSignTexture(name, night);
  const signMaterial = useMemo(() => {
    const made = new MeshBasicMaterial({
      name: "lift-sign",
      map: texture ?? null,
      transparent: true,
      toneMapped: false,
    });
    if (night) {
      made.color.setScalar(nightGlow);
    }
    return made;
  }, [texture, night]);
  useEffect(
    () => () => {
      signMaterial.dispose();
    },
    [signMaterial],
  );
  const [x, y, z] = liftSign.position;
  return (
    <group name="lift-sign" userData={{ text: name, lit: night }}>
      <mesh
        name="lift-sign-plate"
        position={[x, y, z]}
        material={material("ink", "plastic")}
      >
        <boxGeometry args={[...liftSign.size, 0.02]} />
      </mesh>
      <mesh
        name="lift-sign-lettering"
        position={[x, y, z + 0.011]}
        material={signMaterial}
        visible={texture !== undefined && name !== ""}
      >
        <planeGeometry args={[...liftSign.size]} />
      </mesh>
    </group>
  );
}

/** Moves the lift on each frame. */
export function LiftDriver() {
  useFrame((_state, delta) => {
    useLiftStore
      .getState()
      .advance(delta, useSceneSettings.getState().reducedMotion);
  });
  return null;
}

/** How many pixels wide the logo is drawn, so it stays crisp close up. */
const logoPixels = 2048;

/**
 * The logo as a texture: the SVG drawn into a canvas at `logoPixels` wide,
 * once it has loaded. Until then, and where images never load (jsdom), it
 * is undefined.
 */
function useLogoTexture(
  url: string,
  [width, height]: readonly [number, number],
): CanvasTexture | undefined {
  const [texture, setTexture] = useState<CanvasTexture>();
  useEffect(() => {
    let made: CanvasTexture | undefined;
    const image = new Image(
      logoPixels,
      Math.round((logoPixels * height) / width),
    );
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas
        .getContext("2d")
        ?.drawImage(image, 0, 0, canvas.width, canvas.height);
      made = new CanvasTexture(canvas);
      made.colorSpace = SRGBColorSpace;
      made.anisotropy = 16;
      setTexture(made);
    };
    image.src = url;
    return () => {
      image.onload = null;
      made?.dispose();
    };
  }, [url, width, height]);
  return texture;
}

/**
 * The company logo on a wall, `size` across, centred at `position` and
 * turned by `rotationY` from facing +z. It is unlit, so the lighting and
 * tone mapping leave its colours as drawn; it shows once its image has
 * loaded.
 */
export function WallLogo({
  name,
  position,
  size,
  rotationY = 0,
}: {
  name: string;
  position: Vec3;
  size: readonly [number, number];
  rotationY?: number;
}) {
  const texture = useLogoTexture(brand.logo, size);
  const logoMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        name,
        map: texture ?? null,
        transparent: true,
        toneMapped: false,
      }),
    [texture, name],
  );
  useEffect(
    () => () => {
      logoMaterial.dispose();
    },
    [logoMaterial],
  );
  return (
    <mesh
      name={name}
      position={[...position]}
      rotation={[0, rotationY, 0]}
      material={logoMaterial}
      visible={texture !== undefined}
    >
      <planeGeometry args={[...size]} />
    </mesh>
  );
}

/** The company logo on the wall behind reception. */
export function ReceptionLogo() {
  return (
    <WallLogo
      name="reception-logo"
      position={receptionLogo.position}
      size={receptionLogo.size}
    />
  );
}

/**
 * The lobby: its pieces, the logo, the Notice Board's cards, the lift, the
 * reception desk's envelopes and marker once the Connections are read, and
 * its people once they load: the receptionist (the Communications Agent)
 * and the visitor.
 */
export function Lobby({
  board,
  stops,
  cast,
  greeting,
  reception,
}: {
  board: BoardPreview;
  stops: readonly LiftStop[];
  /** The receptionist, who is the Communications Agent, and the visitor. */
  cast?: LobbyCast | undefined;
  /** What the receptionist says to the Owner as the Office opens. */
  greeting?: string | undefined;
  /** What the Communications Agent has sent, and its failing Connections. */
  reception?: Reception | undefined;
}) {
  const events = useSeason((season) => season.events);
  const decorations = useSeason((season) => season.decorations);
  const decor = useMemo(
    () => lobbyDecor(events, decorations),
    [events, decorations],
  );
  // In season, now and then an actor steps out of the lift, goes round
  // the lobby a different way each time saying its piece (Santa leaves
  // presents under the tree) and leaves.
  const visits = useMemo(() => createVisitScheduler(), []);
  const liftHeld = useMemo(() => () => visits.liftDoors(), [visits]);
  const planVisit = useMemo(
    () => (actor: SeasonalActorId) =>
      lobbyVisit(
        actor,
        events.includes("christmas") && useSeason.getState().decorations.trees
          ? [...lobbyTreeSpot]
          : undefined,
        { lines: useSeason.getState().lines[actor] },
      ),
    [events],
  );
  return (
    <group name="lobby">
      <StaticPieces pieces={lobbyPieces} />
      <SeasonalDecor decor={decor} />
      <ReceptionLogo />
      <NoticeBoardCards preview={board} />
      <Lift stops={stops} held={liftHeld} />
      <SeasonalVisitors scheduler={visits} plan={planVisit} />
      {reception !== undefined && <ReceptionDesk {...reception} />}
      {cast !== undefined && <LobbyPeople cast={cast} greeting={greeting} />}
    </group>
  );
}
