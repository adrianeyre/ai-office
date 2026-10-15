import type { Avatar } from "@ai-office/shared/avatar";
import {
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  Mesh,
  SkinnedMesh,
  Sphere,
  Vector3,
  type AnimationAction,
  type Bone,
} from "three";

import {
  animationSpec,
  avatarProps,
  type AnimationName,
  type AvatarProp,
} from "./avatar-animations.ts";
import {
  animationClips,
  avatarGeometry,
  avatarMaterial,
  avatarSkeleton,
  propGeometry,
  type AvatarLod,
} from "./avatar-geometry.ts";
import type { Dress } from "./avatar-parts.ts";
import { avatarRig } from "./avatar-rig.ts";

// One Avatar, ready for the scene: its skinned mesh on the shared rig, its
// props in its right hand (shown only while an animation holds them), and
// a mixer that plays its animations, cross-fading from one to the next.
// It is posed in its first animation as it is made, so it is never seen
// in the rig's rest pose: an Agent at its desk is seated from the first
// frame, never standing in its chair (PRD FR-61, FR-62).

/** How long one animation fades into the next, in seconds. */
export const crossFadeSeconds = 0.3;

export interface AvatarFigure {
  readonly mesh: SkinnedMesh;
  readonly mixer: AnimationMixer;
  /** The animation playing, once one is. */
  readonly playing: () => AnimationName | undefined;
  /**
   * Plays `name`, fading from the one before; `instantly` cuts to it
   * (reduced motion, or the first one). `phase` starts it that share of
   * the way through its loop.
   */
  readonly play: (
    name: AnimationName,
    instantly?: boolean,
    phase?: number,
  ) => void;
  readonly dispose: () => void;
}

/**
 * An Avatar's figure, posed at once in `starting` (an Agent at its desk
 * sits) when given; otherwise in the rig's rest pose until it plays one.
 */
export function avatarFigure(
  avatar: Avatar,
  lod: AvatarLod,
  starting?: AnimationName,
  dress?: Dress,
): AvatarFigure {
  const rig = avatarRig(avatar);
  const geometry = avatarGeometry(avatar, lod, rig, dress);
  const mesh = new SkinnedMesh(geometry, avatarMaterial());
  mesh.name = "avatar";
  const { root, skeleton } = avatarSkeleton(rig);
  mesh.add(root);
  mesh.updateMatrixWorld(true);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Wide enough for every pose (sitting, reaching up), so it is never culled
  // while in view, and three.js never skins it on the CPU to measure it.
  mesh.boundingSphere = new Sphere(
    new Vector3(0, rig.height / 2, 0.2),
    rig.height * 0.75,
  );

  const hand = root.getObjectByName("rightHand") as Bone;
  const props = new Map<AvatarProp, Mesh>();
  for (const prop of avatarProps) {
    const held = new Mesh(propGeometry(avatar, prop, rig), avatarMaterial());
    held.name = prop;
    held.visible = false;
    held.castShadow = true;
    hand.add(held);
    props.set(prop, held);
  }

  const clips = animationClips(rig);
  const mixer = new AnimationMixer(mesh);
  let current: { name: AnimationName; action: AnimationAction } | undefined;

  const figure: AvatarFigure = {
    mesh,
    mixer,
    playing: () => current?.name,
    play(name, instantly = false, phase = 0) {
      if (current?.name === name) {
        return;
      }
      const spec = animationSpec(name, rig);
      const action = mixer.clipAction(clips[name]);
      action.reset();
      // Partners at a game play the same loop out of step: one swings as
      // the other's ball arrives.
      action.time = phase * spec.duration;
      action.setLoop(spec.loop ? LoopRepeat : LoopOnce, Infinity);
      action.clampWhenFinished = !spec.loop;
      action.play();
      if (current !== undefined && !instantly) {
        current.action.crossFadeTo(action, crossFadeSeconds, false);
      } else {
        current?.action.stop();
      }
      current = { name, action };
      for (const [prop, held] of props) {
        held.visible = spec.prop === prop;
      }
      // Pose it at once, before the next frame moves it on.
      mixer.update(0);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(mesh);
      // Its actions are gone: if it is played again (React's Strict Mode
      // disposes a figure and keeps using it), the next play starts afresh
      // rather than taking it for still playing.
      current = undefined;
      geometry.dispose();
      for (const held of props.values()) {
        held.geometry.dispose();
      }
      skeleton.dispose();
    },
  };
  if (starting !== undefined) {
    figure.play(starting, true);
  }
  return figure;
}
