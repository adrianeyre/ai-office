import type { Avatar } from "@ai-office/shared/avatar";

import type { Vec3 } from "./camera-rig.ts";

// The one shared rig every Avatar uses (PRD §7, Motion; the art direction's
// Avatar rig: at most 50 bones and 4 bone influences per vertex). The bones
// are the same for every Avatar; only where they sit changes, with its body
// shape and presentation, so every animation plays on every Avatar. It is
// data only, without three.js: avatar-geometry.ts makes the bones.
//
// An Avatar stands at the origin on the floor, facing +z, its left towards
// +x (glTF's convention). Every bone's rest rotation is none, so a bone's
// axes are the model's: a rotation about x of a negative angle swings a
// hanging limb forwards (+z) and tilts an upright one back.

/** The bones, each after its parent. */
export const boneNames = [
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftForearm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightForearm",
  "rightHand",
  "leftThigh",
  "leftShin",
  "leftFoot",
  "rightThigh",
  "rightShin",
  "rightFoot",
] as const;
export type BoneName = (typeof boneNames)[number];

/** Each bone's parent; the hips are the root. */
export const boneParents: Readonly<Record<BoneName, BoneName | undefined>> = {
  hips: undefined,
  spine: "hips",
  chest: "spine",
  neck: "chest",
  head: "neck",
  leftShoulder: "chest",
  leftUpperArm: "leftShoulder",
  leftForearm: "leftUpperArm",
  leftHand: "leftForearm",
  rightShoulder: "chest",
  rightUpperArm: "rightShoulder",
  rightForearm: "rightUpperArm",
  rightHand: "rightForearm",
  leftThigh: "hips",
  leftShin: "leftThigh",
  leftFoot: "leftShin",
  rightThigh: "hips",
  rightShin: "rightThigh",
  rightFoot: "rightShin",
};

/** The spec's limits for the shared rig. */
export const rigLimits = { bones: 50, influencesPerVertex: 4 } as const;

/** An Avatar's height and build, from its body shape. */
interface Build {
  /** Height in metres, before presentation. */
  readonly height: number;
  /** How broad the shoulders and chest are, against the average. */
  readonly shoulders: number;
  /** How broad the hips are. */
  readonly hips: number;
  /** How thick the limbs are. */
  readonly limbs: number;
  /** How deep the body is, front to back. */
  readonly depth: number;
}

/**
 * The spec's Avatars are 1.70 m tall on average, 1.55 m to 1.85 m by body
 * shape, presentation moving it 3 cm either way.
 */
const builds: Readonly<Record<Avatar["bodyShape"], Build>> = {
  slim: { height: 1.76, shoulders: 0.88, hips: 0.9, limbs: 0.84, depth: 0.88 },
  average: { height: 1.7, shoulders: 1, hips: 1, limbs: 1, depth: 1 },
  broad: {
    height: 1.82,
    shoulders: 1.18,
    hips: 1.08,
    limbs: 1.22,
    depth: 1.18,
  },
  curvy: { height: 1.6, shoulders: 0.98, hips: 1.24, limbs: 1.1, depth: 1.1 },
};

const presentationBuilds: Readonly<
  Record<
    Avatar["presentation"],
    {
      readonly height: number;
      readonly shoulders: number;
      readonly hips: number;
    }
  >
> = {
  male: { height: 0.03, shoulders: 1.06, hips: 0.94 },
  female: { height: -0.03, shoulders: 0.92, hips: 1.08 },
  androgynous: { height: 0, shoulders: 1, hips: 1 },
};

/** The average Avatar's height: every rest position below is for it. */
const averageHeight = 1.7;

/** Where the joints are on an average Avatar standing at rest, in metres. */
const averageJoints = {
  hips: 0.92,
  spine: 1.01,
  chest: 1.18,
  neck: 1.38,
  head: 1.44,
  /** The shoulder blades, either side of the chest's top. */
  shoulder: [0.06, 1.34, -0.01],
  /** The shoulder joint. */
  upperArm: [0.19, 1.32, -0.01],
  elbow: 1.05,
  wrist: 0.8,
  /** The hip joint. */
  thigh: [0.095, 0.85, 0],
  knee: 0.47,
  ankle: 0.08,
} as const;

export interface Rig {
  /** The Avatar's height, top of the head, in metres. */
  readonly height: number;
  /** Its scale against the average Avatar: everything grows with it. */
  readonly scale: number;
  readonly build: Build & { readonly shoulders: number; readonly hips: number };
  /** Each bone's rest position in the model, standing on the floor. */
  readonly joints: Readonly<Record<BoneName, Vec3>>;
  /** Each bone's rest position from its parent's (the hips' from the floor). */
  readonly offsets: Readonly<Record<BoneName, Vec3>>;
  /** From the hip joint to the knee, and the knee to the ankle. */
  readonly thighLength: number;
  readonly shinLength: number;
  /** From the shoulder joint to the elbow, and the elbow to the wrist. */
  readonly upperArmLength: number;
  readonly forearmLength: number;
  /** From the wrist to the fingertips. */
  readonly handLength: number;
  /** The head: its centre and its radii (half its width, height and depth). */
  readonly head: { readonly centre: Vec3; readonly radii: Vec3 };
  /** A limb's thickness at its top: upper arm, forearm, thigh and shin. */
  readonly limbRadii: {
    readonly upperArm: number;
    readonly forearm: number;
    readonly thigh: number;
    readonly shin: number;
  };
}

const add = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [
  ax + bx,
  ay + by,
  az + bz,
];
const subtract = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [
  ax - bx,
  ay - by,
  az - bz,
];

/** Where an Avatar's bones are, from its body shape and presentation. */
export function avatarRig(
  avatar: Pick<Avatar, "bodyShape" | "presentation">,
): Rig {
  const shape = builds[avatar.bodyShape];
  const presentation = presentationBuilds[avatar.presentation];
  const height = shape.height + presentation.height;
  const scale = height / averageHeight;
  const build = {
    ...shape,
    shoulders: shape.shoulders * presentation.shoulders,
    hips: shape.hips * presentation.hips,
  };
  const at = (x: number, y: number, z = 0): Vec3 => [
    x * scale,
    y * scale,
    z * scale,
  ];
  const side = (sign: 1 | -1) => {
    const [shoulderX, shoulderY, shoulderZ] = averageJoints.shoulder;
    const [armX, armY, armZ] = averageJoints.upperArm;
    const [thighX, thighY] = averageJoints.thigh;
    const armAt = armX * build.shoulders;
    return {
      shoulder: at(sign * shoulderX * build.shoulders, shoulderY, shoulderZ),
      upperArm: at(sign * armAt, armY, armZ),
      forearm: at(sign * armAt, averageJoints.elbow, armZ),
      hand: at(sign * armAt, averageJoints.wrist, armZ),
      thigh: at(sign * thighX * build.hips, thighY),
      shin: at(sign * thighX * build.hips, averageJoints.knee),
      foot: at(sign * thighX * build.hips, averageJoints.ankle),
    };
  };
  const left = side(1);
  const right = side(-1);
  const joints: Record<BoneName, Vec3> = {
    hips: at(0, averageJoints.hips),
    spine: at(0, averageJoints.spine),
    chest: at(0, averageJoints.chest),
    neck: at(0, averageJoints.neck),
    head: at(0, averageJoints.head),
    leftShoulder: left.shoulder,
    leftUpperArm: left.upperArm,
    leftForearm: left.forearm,
    leftHand: left.hand,
    rightShoulder: right.shoulder,
    rightUpperArm: right.upperArm,
    rightForearm: right.forearm,
    rightHand: right.hand,
    leftThigh: left.thigh,
    leftShin: left.shin,
    leftFoot: left.foot,
    rightThigh: right.thigh,
    rightShin: right.shin,
    rightFoot: right.foot,
  };
  const offsets = Object.fromEntries(
    boneNames.map((bone) => {
      const parent = boneParents[bone];
      return [
        bone,
        parent === undefined
          ? joints[bone]
          : subtract(joints[bone], joints[parent]),
      ];
    }),
  ) as Record<BoneName, Vec3>;
  // The head is about a sixth of the height: the spec's stylised
  // proportions of about six heads tall, its top at the Avatar's height.
  const headHeight = 0.27 * scale;
  return {
    height,
    scale,
    build,
    joints,
    offsets,
    thighLength: (averageJoints.thigh[1] - averageJoints.knee) * scale,
    shinLength: (averageJoints.knee - averageJoints.ankle) * scale,
    upperArmLength: (averageJoints.upperArm[1] - averageJoints.elbow) * scale,
    forearmLength: (averageJoints.elbow - averageJoints.wrist) * scale,
    handLength: 0.09 * scale,
    head: {
      centre: add(at(0, 0, 0.01), [0, height - headHeight / 2, 0]),
      radii: [0.105 * scale, headHeight / 2, 0.115 * scale],
    },
    limbRadii: {
      upperArm: 0.048 * scale * build.limbs,
      forearm: 0.04 * scale * build.limbs,
      thigh: 0.07 * scale * build.limbs * Math.sqrt(build.hips),
      shin: 0.052 * scale * build.limbs,
    },
  };
}
