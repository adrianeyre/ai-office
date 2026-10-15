import {
  randomAvatar,
  seededRandom,
  type Avatar,
} from "@ai-office/shared/avatar";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { Mesh, SkinnedMesh, type BufferAttribute } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { avatarGeometry } from "./avatar-geometry.ts";
import { AvatarPreviewStage, mascotStand } from "./avatar-preview.tsx";
import { avatarRig } from "./avatar-rig.ts";
import { desk } from "./desk-set.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";

// The Avatar Editor's preview (PRD FR-13), rendered without WebGL by React
// Three Fiber's test renderer: the Avatar at its finest LOD on a turntable
// with its mascot, rebuilt as the draft changes, turned by the editor, and
// standing idle (still, with reduced motion).

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

let renderer: Renderer | undefined;

const avatar = randomAvatar(seededRandom("preview"));

async function renderStage(shown: Avatar, turn = 0): Promise<Renderer> {
  renderer = await ReactThreeTestRenderer.create(
    <AvatarPreviewStage avatar={shown} turn={turn} />,
  );
  return renderer;
}

const figureOf = (scene: Renderer): SkinnedMesh => {
  const mesh = scene.scene.instance.getObjectByName("avatar");
  if (!(mesh instanceof SkinnedMesh)) {
    throw new Error("The preview has no Avatar.");
  }
  return mesh as SkinnedMesh;
};

/** Where a bone is in the world, as numbers. */
const boneAt = (mesh: SkinnedMesh, name: string) => {
  mesh.updateMatrixWorld(true);
  const bone = mesh.skeleton.bones.find((each) => each.name === name);
  return bone?.getWorldPosition(bone.position.clone()).toArray();
};

beforeEach(() => {
  localStorage.clear();
  resetSceneSettings();
});

afterEach(async () => {
  await renderer?.unmount();
  renderer = undefined;
  localStorage.clear();
});

describe("the Avatar Editor's preview", () => {
  it("stands the Avatar on a turntable at its finest LOD, its mascot on a plinth beside it", async () => {
    const scene = await renderStage(avatar);
    const figure = figureOf(scene);
    // LOD0, as High draws it: the finest there is.
    const finest = avatarGeometry(avatar, 0, avatarRig(avatar));
    expect(figure.geometry.getIndex()?.count).toBe(finest.getIndex()?.count);
    expect(figure.geometry.getIndex()?.count ?? 0).toBeGreaterThan(
      avatarGeometry(avatar, 1, avatarRig(avatar)).getIndex()?.count ?? 0,
    );
    expect(figure.castShadow).toBe(true);

    const mascot = scene.scene.instance.getObjectByName("desk-mascot");
    expect(mascot).toBeInstanceOf(Mesh);
    expect(mascot?.position.toArray()).toEqual([
      mascotStand.at[0],
      desk.top,
      mascotStand.at[2],
    ]);
    expect(scene.scene.instance.getObjectByName("turntable")).toBeDefined();
  });

  it("rebuilds the Avatar as the draft changes, and only then", async () => {
    const scene = await renderStage(avatar);
    const first = figureOf(scene);
    const colours = () =>
      [
        ...(figureOf(scene).geometry.getAttribute("color") as BufferAttribute)
          .array,
      ].join(",");
    const before = colours();

    // The same look, in a new object: the same figure.
    await act(async () => {
      await scene.update(
        <AvatarPreviewStage avatar={structuredClone(avatar)} turn={0} />,
      );
    });
    expect(figureOf(scene)).toBe(first);

    const blue = {
      ...avatar,
      hairColour: avatar.hairColour === "#2e6fd8" ? "#d64f8f" : "#2e6fd8",
    };
    await act(async () => {
      await scene.update(<AvatarPreviewStage avatar={blue} turn={0} />);
    });
    expect(figureOf(scene)).not.toBe(first);
    expect(colours()).not.toBe(before);
  });

  it("turns as the editor says", async () => {
    const scene = await renderStage(avatar, Math.PI / 6);
    const stage = scene.scene.instance.getObjectByName("avatar-preview");
    expect(stage?.rotation.y).toBeCloseTo(Math.PI / 6);
    await act(async () => {
      await scene.update(
        <AvatarPreviewStage avatar={avatar} turn={-Math.PI / 3} />,
      );
    });
    expect(stage?.rotation.y).toBeCloseTo(-Math.PI / 3);
  });

  it("stands idle, breathing, and holds still with reduced motion", async () => {
    const scene = await renderStage(avatar);
    const figure = figureOf(scene);
    const start = boneAt(figure, "spine");
    await act(async () => {
      await scene.advanceFrames(30, 1 / 30);
    });
    expect(boneAt(figure, "spine")).not.toEqual(start);

    useSceneSettings.getState().setReducedMotion(true);
    const held = boneAt(figure, "spine");
    await act(async () => {
      await scene.advanceFrames(30, 1 / 30);
    });
    expect(boneAt(figure, "spine")).toEqual(held);
  });
});
