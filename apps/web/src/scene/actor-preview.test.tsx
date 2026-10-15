import { seasonalActorIds } from "@ai-office/shared";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { SkinnedMesh } from "three";
import { afterEach, describe, expect, it } from "vitest";

import { ActorPreviewStage } from "./actor-preview.tsx";

// Each seasonal actor on its turntable in General Settings, rendered
// without WebGL by React Three Fiber's test renderer.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

let renderer: Renderer | undefined;

afterEach(async () => {
  await renderer?.unmount();
  renderer = undefined;
});

describe("a seasonal actor's preview", () => {
  it.each(seasonalActorIds)("stands %s on a turntable", async (actor) => {
    renderer = await ReactThreeTestRenderer.create(
      <ActorPreviewStage actor={actor} />,
    );
    const scene = renderer.scene.instance;
    expect(scene.getObjectByName("turntable")).toBeDefined();
    expect(scene.getObjectByName("avatar")).toBeInstanceOf(SkinnedMesh);
    await renderer.advanceFrames(2, 1 / 60);
  });
});
