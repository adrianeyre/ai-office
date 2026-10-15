import "./styles.css";

import { palette } from "@ai-office/shared/palette";
import { _roots } from "@react-three/fiber";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { brand } from "../src/brand/brand.ts";
import { AvatarPreview } from "../src/scene/avatar-preview.tsx";
import { restingAt } from "../src/scene/camera-rig.ts";
import { useCameraStore } from "../src/scene/camera-store.ts";
import { liftAt } from "../src/scene/lift.ts";
import { useLiftStore } from "../src/scene/lift-store.ts";
import { loadModels, provideModels } from "../src/scene/models.ts";
import { boardPreview } from "../src/scene/notice-board-preview.ts";
import { OfficeScene } from "../src/scene/office-scene.tsx";
import { useSceneSettings } from "../src/scene/scene-settings.ts";
import {
  aboveHead,
  editorAvatar,
  floorId,
  inLobby,
  isSceneName,
  lobbyCast,
  looks,
  monitors,
  notices,
  officeSize,
  previewSize,
  reception,
  sceneViews,
  stops,
  team,
  type SceneName,
} from "./scene-data.ts";

// The page the screenshot tests open (e2e/scenes/): one scene of the
// 3D Office, `?scene=lobby` (with the Communications Agent at its
// reception desk), `reception` (close in on that desk), `floor`,
// `above-head` (that Floor, with the Context Usage bars and tokens that
// float, in HTML, above its Agents' heads), `meeting-room` or
// `avatar-editor`,
// drawn by the Office's own components from the fixed data in
// scene-data.ts, at Medium quality with reduced motion (so every Avatar
// holds its pose and nothing moves), from a fixed camera. The models and
// the logo are loaded before the scene is drawn, so its first frame is
// complete. Once it has drawn `settleFrames` frames it stops drawing, so
// the canvas holds still to be compared, and the page's `data-scene` says
// "ready" (or "failed", with the reason in `data-scene-error`).

/** Frames drawn before the scene counts as ready. */
const settleFrames = 10;

const root = document.documentElement;

function fail(error: unknown): void {
  root.dataset["scene"] = "failed";
  root.dataset["sceneError"] =
    error instanceof Error ? error.message : String(error);
}

/** Resolves after `count` animation frames. */
const frames = (count: number): Promise<void> =>
  new Promise((resolve) => {
    const step = (left: number) => {
      if (left === 0) {
        resolve();
      } else {
        requestAnimationFrame(() => {
          step(left - 1);
        });
      }
    };
    step(count);
  });

/** The models every Floor places, loaded into the scene before it draws. */
async function preloadModels(): Promise<void> {
  provideModels(
    await loadModels(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${url.pathname} answered ${String(response.status)}.`);
      }
      return response.arrayBuffer();
    }),
  );
}

/** The lobby's logo, loaded and decoded, so the scene's copy is drawn at once. */
async function preloadLogo(): Promise<void> {
  const image = new Image();
  image.src = brand.logo;
  await image.decode();
}

function Scene({ scene }: { scene: SceneName }) {
  if (scene === "avatar-editor") {
    return (
      <div
        style={{
          position: "relative",
          ...previewSize,
          background: palette["light-sky"],
        }}
      >
        <AvatarPreview avatar={editorAvatar} turn={0} />
      </div>
    );
  }
  const onFloor = !inLobby(scene);
  return (
    <div data-scene-view style={{ position: "relative", ...officeSize }}>
      <OfficeScene
        quality="medium"
        showFps={false}
        board={boardPreview(
          onFloor
            ? notices.filter((notice) => notice.floorId === floorId)
            : notices,
        )}
        stops={stops}
        team={onFloor ? team : undefined}
        monitors={onFloor ? monitors : undefined}
        looks={onFloor ? looks : undefined}
        needsOwner={onFloor}
        handoffs={[]}
        inspectables={[]}
        cast={onFloor ? undefined : lobbyCast}
        reception={onFloor ? undefined : reception}
        aboveHead={scene === "above-head" ? aboveHead : undefined}
      />
    </div>
  );
}

async function show(): Promise<void> {
  const scene = new URLSearchParams(location.search).get("scene");
  if (!isSceneName(scene)) {
    throw new Error(`There is no scene named "${String(scene)}".`);
  }
  const element = document.getElementById("root");
  if (element === null) {
    throw new Error("index.html has no #root element.");
  }

  useSceneSettings.setState({
    quality: "medium",
    reducedMotion: true,
    showFps: false,
  });
  if (scene !== "avatar-editor") {
    useLiftStore.setState({
      lift: liftAt(
        inLobby(scene)
          ? { order: 0, location: { kind: "lobby" } }
          : { order: 1, location: { kind: "floor", floorId } },
      ),
      pickerOpen: false,
    });
    useCameraStore.setState({
      rig: restingAt({ view: scene, pose: sceneViews[scene] }),
    });
  }
  await Promise.all([
    scene === "avatar-editor" ? undefined : preloadModels(),
    inLobby(scene) ? preloadLogo() : undefined,
  ]);

  createRoot(element).render(
    <StrictMode>
      <Scene scene={scene} />
    </StrictMode>,
  );
  // The canvas is made once React has rendered, and draws from then on.
  while (element.querySelector("canvas") === null) {
    await frames(1);
  }
  await frames(settleFrames);
  // Drawn: the canvas keeps its last frame, and nothing draws over it.
  for (const { store } of _roots.values()) {
    store.getState().setFrameloop("never");
  }
  root.dataset["scene"] = "ready";
}

show().catch(fail);
