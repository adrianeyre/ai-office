import type { FloorTheme, LobbyCast } from "@ai-office/shared";
import { palette } from "@ai-office/shared/palette";
import { Environment, Lightformer } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Bloom,
  BrightnessContrast,
  EffectComposer,
  HueSaturation,
  N8AO,
  SMAA,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useEffect, useMemo, useRef } from "react";

import {
  cameraFov,
  defaultView,
  officeViews,
  useCameraStore,
} from "./camera-store.ts";
import { ColourGradeEffect } from "./colour-grade.ts";
import { FpsMeter, useFpsStore } from "./fps.ts";
import type { LiftStop } from "./lift-stops.ts";
import {
  ambientLight,
  environmentIntensity,
  fillLight,
  keyLight,
  lightPositions,
  shadowBias,
} from "./lighting.ts";
import type { AboveHead, FreshStartSignal } from "./above-head.ts";
import type { AgentLook } from "./agent-state.ts";
import type { FloorAgent } from "./floor-layout.ts";
import type { HandoffTicket } from "./handoff-walks.ts";
import type { FloorGrilling } from "./floor.tsx";
import type { FactFindingVisit } from "./grilling-walks.ts";
import type { MeetingSignal } from "./meeting-walks.ts";
import type { ContractorSignal } from "./contractor-walks.ts";
import type { InspectableObject } from "./inspectable.ts";
import { isRiding } from "./lift.ts";
import { useLiftStore } from "./lift-store.ts";
import { LiftDriver } from "./lobby.tsx";
import type { MonitorScreen } from "./monitor-preview.ts";
import { OfficeLocationScene } from "./office-location.tsx";
import type { BoardPreview } from "./notice-board-preview.ts";
import type { Reception } from "./reception-desk.tsx";
import {
  canvasDpr,
  qualityPresets,
  type QualityLevel,
  type QualityPreset,
} from "./quality.ts";
import { attachMouseCamera } from "./mouse-camera.ts";
import { useSceneSettings } from "./scene-settings.ts";
import { attachTouchCamera } from "./touch-camera.ts";

// The 3D Office's canvas (PRD §6.11): React Three Fiber with drei, the
// lighting and post-processing of docs/reference/art-direction.md, and the
// camera rig. It holds no text and no panels: those are HTML, outside the
// canvas (office-view.tsx), and so are the labels that float in it, such as
// the display above each Agent's head (above-head.tsx). It shows where the lift is: the lobby, with its
// Notice Board's preview of the latest Notices (lobby.tsx), or a Floor with
// a desk for each of its Agents, its monitor showing what the Agent is
// doing (floor.tsx); and, wherever it is, the objects that can be
// inspected (inspectable-hotspots.tsx). On a touch screen, fingers move
// the camera (touch-camera.ts); on a desktop, the mouse does
// (mouse-camera.ts).

/** How far the shadow camera reaches from the Floor's centre, in metres. */
const shadowReach = 16;

const lights = lightPositions(officeViews[defaultView]);

function Lights({ preset }: { preset: QualityPreset }) {
  const { shadows } = preset;
  return (
    <>
      <directionalLight
        color={palette["light-key"]}
        intensity={keyLight.intensity}
        position={lights.key}
        castShadow={shadows !== undefined}
        shadow-mapSize={[shadows?.mapSize ?? 512, shadows?.mapSize ?? 512]}
        shadow-radius={shadows?.radius ?? 1}
        shadow-bias={shadowBias.bias}
        shadow-normalBias={shadowBias.normalBias}
        shadow-camera-left={-shadowReach}
        shadow-camera-right={shadowReach}
        shadow-camera-top={shadowReach}
        shadow-camera-bottom={-shadowReach}
        shadow-camera-near={1}
        shadow-camera-far={80}
      />
      <directionalLight
        color={palette["light-fill"]}
        intensity={fillLight.intensity}
        position={lights.fill}
      />
      <hemisphereLight
        args={[
          palette["light-sky"],
          palette["light-ground"],
          ambientLight.intensity,
        ]}
      />
      {/* A small interior environment, for reflections on metal and glass
          only. Drawn once from these panels, so nothing is downloaded. */}
      <Environment
        frames={1}
        resolution={64}
        environmentIntensity={environmentIntensity}
      >
        <Lightformer
          color={palette.ceiling}
          intensity={1}
          position={[0, 5, 0]}
          rotation-x={Math.PI / 2}
          scale={[12, 12, 1]}
        />
        <Lightformer
          color={palette["light-fill"]}
          intensity={0.6}
          position={[-8, 2, 0]}
          rotation-y={Math.PI / 2}
          scale={[10, 3, 1]}
        />
        <Lightformer
          color={palette.wall}
          intensity={0.4}
          position={[8, 2, 0]}
          rotation-y={-Math.PI / 2}
          scale={[10, 3, 1]}
        />
      </Environment>
    </>
  );
}

/** Moves the camera rig on each frame, and puts the camera where it says. */
function CameraRig() {
  useFrame(({ camera }, delta) => {
    const { advance } = useCameraStore.getState();
    advance(delta, useSceneSettings.getState().reducedMotion);
    const { pose } = useCameraStore.getState().rig;
    camera.position.set(...pose.position);
    camera.lookAt(...pose.target);
  });
  return null;
}

/**
 * Lets fingers move the camera on a tablet (touch-camera.ts), except
 * while the lift is taking it somewhere.
 */
function TouchCamera() {
  const element = useThree((state) => state.gl.domElement);
  useEffect(
    () =>
      attachTouchCamera(element, {
        fov: cameraFov,
        enabled: () => !isRiding(useLiftStore.getState().lift),
      }),
    [element],
  );
  return null;
}

/**
 * Lets the mouse turn, tilt, pan and zoom the camera (mouse-camera.ts),
 * except while the lift is taking it somewhere.
 */
function MouseCamera() {
  const element = useThree((state) => state.gl.domElement);
  useEffect(
    () =>
      attachMouseCamera(element, {
        fov: cameraFov,
        enabled: () => !isRiding(useLiftStore.getState().lift),
      }),
    [element],
  );
  return null;
}

/** Measures the frame rate for the FPS overlay, while it is shown. */
function FpsProbe() {
  const meter = useRef<FpsMeter>(null);
  useFrame(() => {
    meter.current ??= new FpsMeter();
    const reading = meter.current.frame(performance.now());
    if (reading !== undefined) {
      useFpsStore.setState({ reading });
    }
  });
  useEffect(
    () => () => {
      useFpsStore.setState({ reading: undefined });
    },
    [],
  );
  return null;
}

/**
 * The art direction's effects, in its order. The composer tone-maps, so
 * the renderer's own tone mapping is off (`flat` on the canvas).
 */
function PostProcessing({ preset }: { preset: QualityPreset }) {
  const grade = useMemo(() => new ColourGradeEffect(), []);
  useEffect(
    () => () => {
      grade.dispose();
    },
    [grade],
  );
  const effects = preset.postProcessing;
  return (
    <EffectComposer
      multisampling={effects.multisampling}
      enableNormalPass={false}
      stencilBuffer={false}
    >
      {effects.ambientOcclusion === "off" ? (
        <></>
      ) : (
        <N8AO
          aoRadius={0.5}
          distanceFalloff={0.5}
          intensity={2}
          color={palette.shadow}
          halfRes={effects.ambientOcclusion === "half"}
        />
      )}
      {effects.bloom ? (
        <Bloom
          luminanceThreshold={0.9}
          luminanceSmoothing={0.2}
          intensity={0.4}
          mipmapBlur
          radius={0.6}
        />
      ) : (
        <></>
      )}
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <HueSaturation saturation={0.05} />
      <BrightnessContrast contrast={0.05} />
      <primitive object={grade} />
      {effects.vignette ? <Vignette offset={0.3} darkness={0.35} /> : <></>}
      {effects.smaa ? <SMAA /> : <></>}
    </EffectComposer>
  );
}

/**
 * The canvas at a quality setting. A new setting makes a new canvas, so
 * shadows, multisampling and the pixel ratio all start afresh; the camera
 * keeps its place, because the rig lives in a store.
 */
export function OfficeScene({
  quality,
  showFps,
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
  inspectables,
  cast,
  greeting,
  reception,
  aboveHead,
  freshStarts,
}: {
  quality: QualityLevel;
  showFps: boolean;
  /**
   * What the board where the lift is shows: the lobby's Notice Board, or
   * the Floor's wall board.
   */
  board: BoardPreview;
  /** Where the lift goes. */
  stops: readonly LiftStop[];
  /** The 3D theme of the Floor the lift is at (FR-57). */
  theme?: FloorTheme | undefined;
  /** The Agents of the Floor the lift is at. */
  team?: readonly FloorAgent[] | undefined;
  /** What each of that Floor's monitors shows, by its Agent's id. */
  monitors?: ReadonlyMap<string, MonitorScreen> | undefined;
  /** How each of that Floor's Agents' states looks, by its id (FR-62). */
  looks?: ReadonlyMap<string, AgentLook> | undefined;
  /** Whether that Floor has an action Notice: the Manager's red light. */
  needsOwner?: boolean | undefined;
  /** That Floor's Handoffs, oldest first: each new one is walked (FR-59). */
  handoffs?: readonly HandoffTicket[] | undefined;
  /** That Floor's Kickoffs and Wrap-ups, oldest first (FR-60). */
  meetings?: readonly MeetingSignal[] | undefined;
  /** That Floor's Contractors coming and going, oldest first (ADR 0004). */
  contractors?: readonly ContractorSignal[] | undefined;
  /** That Floor's running Grilling Session, if one runs (FR-83). */
  grilling?: FloorGrilling | undefined;
  /** Whether the Floor\'s Grilling Sessions are known yet (true when left out). */
  grillingKnown?: boolean | undefined;
  /** That Floor's fact-finding events, oldest first: each new one is a visit to the Manager. */
  factFinding?: readonly FactFindingVisit[] | undefined;
  /** The idle activities turned off on the Floor shown, by name. */
  disabledActivities?: readonly string[] | undefined;
  /** The objects that can be inspected where the lift is. */
  inspectables: readonly InspectableObject[];
  /** The lobby's receptionist (the Communications Agent) and visitor; none until they load. */
  cast?: LobbyCast | undefined;
  /** What the receptionist says to the Owner as the Office opens. */
  greeting?: string | undefined;
  /** What the lobby's reception desk shows (FR-96); nothing until the Connections are read. */
  reception?: Reception | undefined;
  /**
   * What floats above each of that Floor's Agents' heads, by its id: its
   * Context Usage bar and its tokens today (FR-62, FR-85).
   */
  aboveHead?: ReadonlyMap<string, AboveHead> | undefined;
  /** That Floor's Fresh Starts, oldest first: each new one empties its Agent's bar. */
  freshStarts?: readonly FreshStartSignal[] | undefined;
}) {
  const preset = qualityPresets[quality];
  const { pose } = useCameraStore.getState().rig;
  return (
    <Canvas
      key={quality}
      aria-hidden
      // Fingers move the camera here, rather than scroll or zoom the page.
      className="touch-none"
      // Over the whole view, whatever its height comes from: as a style,
      // since the Canvas sets `position: relative` and `height: 100%`
      // inline, which a class cannot override, and 100% of a view sized
      // by flex alone is nothing (it fell back to a canvas's 150 px).
      style={{ position: "absolute", inset: 0, width: "auto", height: "auto" }}
      dpr={canvasDpr(preset)}
      // PCFShadowMap ("percentage"), not the spec's PCFSoftShadowMap: this
      // three.js (r186) has removed that one, falling back to this with a
      // warning, and this one's `radius` now gives the soft edge.
      shadows={preset.shadows === undefined ? false : "percentage"}
      flat
      gl={{
        antialias: false,
        stencil: false,
        powerPreference: "high-performance",
      }}
      camera={{
        fov: cameraFov,
        near: 0.1,
        far: 200,
        position: [...pose.position],
      }}
    >
      <color attach="background" args={[palette["light-sky"]]} />
      <Lights preset={preset} />
      <OfficeLocationScene
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
        disabledActivities={disabledActivities}
        inspectables={inspectables}
        cast={cast}
        greeting={greeting}
        reception={reception}
        aboveHead={aboveHead}
        freshStarts={freshStarts}
      />
      <LiftDriver />
      <CameraRig />
      <TouchCamera />
      <MouseCamera />
      {showFps && <FpsProbe />}
      <PostProcessing preset={preset} />
    </Canvas>
  );
}
