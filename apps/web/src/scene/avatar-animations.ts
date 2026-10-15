import type { Vec3 } from "./camera-rig.ts";
import { boneParents, type BoneName, type Rig } from "./avatar-rig.ts";
import { chair, chairOffset, desk } from "./desk-set.ts";

// The Avatars' animations (PRD §7, Motion; FR-59, FR-61, FR-62): one set for the
// shared rig, so every Avatar plays every one. Each is data: poses at
// times, each pose a rotation per bone (Euler XYZ, radians, from rest) and
// how far the hips have moved. Poses that must meet the Office (sitting on
// a chair's seat with the feet on the floor, typing at the desk's keyboard,
// squatting with the feet still) are solved for each Avatar's rig, so a
// tall Avatar's hands reach the keys as a short one's do. avatar-geometry.ts
// makes three.js clips of them, and avatar.tsx plays them.
//
// An Avatar at a desk sits at its chair's seat (the origin here), facing
// +z, the desk's front edge ahead of it.

export const animationNames = [
  "idle",
  "sit",
  "type",
  "walk",
  "carry",
  "hand-over",
  "stand-up",
  "sit-down",
  "stretch",
  "sleep",
  "drink",
  "work-out",
  "chat",
  "wait",
  // The games hall's, the gym's and the darts' (FR-61).
  "throw",
  "swing",
  "lift",
  "foosball",
  "pool",
  "shoot",
  "putt",
  "pedal",
  "row",
  "punch",
  // The seasonal actors' (Santa, Halloween's frights, the Easter Bunny,
  // New Year's drunks, and the ghost, who floats).
  "run",
  "hop",
  "scare",
  "stagger",
  "sway",
  "float",
] as const;
export type AnimationName = (typeof animationNames)[number];

/**
 * What an Avatar may hold in its right hand while it plays an animation:
 * a mug and a ticket at work, and a dart, a table tennis bat, a dumbbell,
 * a pool cue and a putter at play (FR-61).
 */
export const avatarProps = [
  "mug",
  "ticket",
  "dart",
  "bat",
  "dumbbell",
  "cue",
  "putter",
] as const;
export type AvatarProp = (typeof avatarProps)[number];

/**
 * A table tennis rally's timing (FR-61): one swing's loop, and when in it
 * the bat meets the ball. The Agent at the far end plays it half a loop
 * behind, so the ball crosses the table in half a loop each way.
 */
export const rally = { seconds: 1.6, batMeetsBall: 0.2 } as const;

export interface Pose {
  /** Each bone's rotation from rest; a bone not named is at rest. */
  readonly rotations: Partial<Readonly<Record<BoneName, Vec3>>>;
  /** How far the hips have moved from rest. */
  readonly hips: Vec3;
}

export interface PoseKey {
  readonly time: number;
  readonly pose: Pose;
}

export interface AnimationSpec {
  readonly name: AnimationName;
  /** In seconds. */
  readonly duration: number;
  /** A loop's last pose is its first, at `duration`; a one-shot ends on its last key. */
  readonly loop: boolean;
  /** Seated at a desk's chair, rather than standing. */
  readonly seated: boolean;
  readonly prop?: AvatarProp;
  readonly keys: readonly PoseKey[];
}

const still: Vec3 = [0, 0, 0];

/** A pose: `base` with some bones turned further, and the hips moved. */
function adjust(
  base: Pose,
  turns: Partial<Record<BoneName, Vec3>> = {},
  hips: Vec3 = still,
): Pose {
  const rotations: Partial<Record<BoneName, Vec3>> = { ...base.rotations };
  for (const [bone, [x, y, z]] of Object.entries(turns) as [BoneName, Vec3][]) {
    const [bx, by, bz] = rotations[bone] ?? still;
    rotations[bone] = [bx + x, by + y, bz + z];
  }
  return {
    rotations,
    hips: [
      base.hips[0] + hips[0],
      base.hips[1] + hips[1],
      base.hips[2] + hips[2],
    ],
  };
}

/** Rotates a point in the y-z plane about x. */
const turnX = ([y, z]: readonly [number, number], angle: number) =>
  [
    y * Math.cos(angle) - z * Math.sin(angle),
    y * Math.sin(angle) + z * Math.cos(angle),
  ] as const;

/**
 * Where a bone is in a pose, in the y-z plane, for poses that turn the
 * bones on its way from the hips about x alone: the torso and the limbs
 * swinging forwards and back.
 */
export function jointYZ(
  rig: Rig,
  pose: Pose,
  bone: BoneName,
): readonly [number, number] {
  const chain: BoneName[] = [];
  for (
    let each: BoneName | undefined = bone;
    each !== undefined;
    each = boneParents[each]
  ) {
    chain.unshift(each);
  }
  let position: readonly [number, number] = [
    rig.joints.hips[1] + pose.hips[1],
    rig.joints.hips[2] + pose.hips[2],
  ];
  let angle = 0;
  for (const [index, each] of chain.entries()) {
    if (index > 0) {
      const [, oy, oz] = rig.offsets[each];
      const [dy, dz] = turnX([oy, oz], angle);
      position = [position[0] + dy, position[1] + dz];
    }
    angle += (pose.rotations[each] ?? still)[0];
  }
  return position;
}

/** The sum of the x rotations from the hips to `bone`, inclusive. */
function pitchTo(pose: Pose, bone: BoneName): number {
  let angle = 0;
  for (
    let each: BoneName | undefined = bone;
    each !== undefined;
    each = boneParents[each]
  ) {
    angle += (pose.rotations[each] ?? still)[0];
  }
  return angle;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/**
 * A two-bone limb's turns about x that put its end at `target` (y, z) from
 * its root at `root`: the root bone's and the middle joint's, as angles
 * from hanging straight down, forwards positive. `bend` is the way the
 * middle joint folds: forwards (+1, an elbow lifting the forearm) or back
 * (-1, a knee).
 */
function twoBone(
  root: readonly [number, number],
  target: readonly [number, number],
  upper: number,
  lower: number,
  bend: 1 | -1,
): { readonly upper: number; readonly lower: number } {
  const dy = target[0] - root[0];
  const dz = target[1] - root[1];
  const reach = clamp(
    Math.hypot(dy, dz),
    Math.abs(upper - lower) + 1e-3,
    upper + lower - 1e-3,
  );
  // The line from the root to the target, from straight down, forwards positive.
  const line = Math.atan2(dz, -dy);
  const atRoot = Math.acos(
    clamp((upper ** 2 + reach ** 2 - lower ** 2) / (2 * upper * reach), -1, 1),
  );
  const atEnd = Math.acos(
    clamp((lower ** 2 + reach ** 2 - upper ** 2) / (2 * lower * reach), -1, 1),
  );
  return { upper: line - bend * atRoot, lower: line + bend * atEnd };
}

/**
 * The arms hang a little away from the body, far enough that the hands
 * clear the hips: broad hips hold them further out.
 */
function restArms(rig: Rig): Partial<Record<BoneName, Vec3>> {
  const pelvis = 0.15 * rig.scale * rig.build.hips;
  const arm = rig.joints.leftUpperArm[0];
  const clearance = pelvis + rig.limbRadii.forearm + 0.012 * rig.scale - arm;
  const down = rig.joints.leftUpperArm[1] - rig.joints.hips[1];
  const out = 0.07 + Math.max(0, Math.atan2(clearance, down));
  return {
    leftUpperArm: [0, 0, out],
    rightUpperArm: [0, 0, -out],
    leftForearm: [-0.12, 0, 0],
    rightForearm: [-0.12, 0, 0],
  };
}

/** Standing at rest, the arms by the sides. */
export function standingPose(rig: Rig): Pose {
  return { rotations: restArms(rig), hips: still };
}

/** The top of a chair's seat, where the thighs rest. */
export const seatHeight = chair.seat;

/**
 * Sitting on a chair's seat, its centre at the origin: the hip joints just
 * above the seat, the thighs along it and the shins down, tilted so the
 * feet are flat on the floor whatever the Avatar's height.
 */
export function seatedPose(rig: Rig): Pose {
  const hipJoint = rig.joints.leftThigh[1];
  const seatedJoint = seatHeight + rig.limbRadii.thigh * 0.85;
  const hips: Vec3 = [0, seatedJoint - hipJoint, 0.03 * rig.scale];
  const ankle = rig.joints.leftFoot[1];
  // Short legs slope the thighs down to reach the floor; long ones push
  // the feet forwards.
  const slope = Math.asin(
    clamp((seatedJoint - rig.shinLength - ankle) / rig.thighLength, 0, 0.6),
  );
  const kneeY = seatedJoint - rig.thighLength * Math.sin(slope);
  const forwards = Math.acos(clamp((kneeY - ankle) / rig.shinLength, 0, 1));
  const thigh = -(Math.PI / 2 - slope);
  const shin = -forwards - thigh;
  const foot = forwards;
  return {
    rotations: {
      leftThigh: [thigh, 0, -0.03],
      rightThigh: [thigh, 0, 0.03],
      leftShin: [shin, 0, 0],
      rightShin: [shin, 0, 0],
      leftFoot: [foot, 0, 0.03],
      rightFoot: [foot, 0, -0.03],
      leftUpperArm: [-0.3, 0, 0.12],
      rightUpperArm: [-0.3, 0, -0.12],
      leftForearm: [-0.85, 0, 0],
      rightForearm: [-0.85, 0, 0],
    },
    hips,
  };
}

/** Where the keyboard is from the chair: on the desk, in front of the Avatar. */
export const keyboardAt = {
  /** Its top. */
  y: desk.top + 0.02,
  /** Its middle, from the seat's centre. */
  z: chairOffset - 0.17,
} as const;

/**
 * Seated at the desk with the hands on the keyboard: the torso leaning in
 * a little, the arms solved so the wrists rest just behind the keys.
 */
export function typingPose(rig: Rig): Pose {
  const seated = seatedPose(rig);
  const leaning = adjust(seated, {
    spine: [0.06, 0, 0],
    chest: [0.04, 0, 0],
    head: [0.12, 0, 0],
  });
  const torso = pitchTo(leaning, "chest");
  const shoulder = jointYZ(rig, leaning, "leftUpperArm");
  const wrist: readonly [number, number] = [
    keyboardAt.y + 0.035,
    keyboardAt.z - 0.08,
  ];
  const arm = twoBone(
    shoulder,
    wrist,
    rig.upperArmLength,
    rig.forearmLength,
    1,
  );
  // The hands lie forwards over the keys, drooping a little.
  const hand = Math.PI / 2 - 0.3;
  const rotations: Partial<Record<BoneName, Vec3>> = { ...leaning.rotations };
  for (const side of ["left", "right"] as const) {
    const out = side === "left" ? 1 : -1;
    rotations[`${side}UpperArm`] = [-arm.upper - torso, 0, out * 0.05];
    rotations[`${side}Forearm`] = [-(arm.lower - arm.upper), 0, 0];
    rotations[`${side}Hand`] = [-(hand - arm.lower), 0, 0];
  }
  return { rotations, hips: leaning.hips };
}

type Quat = readonly [number, number, number, number];

const length = ([x, y, z]: Vec3) => Math.hypot(x, y, z);
const unit = (v: Vec3): Vec3 => {
  const size = length(v) || 1;
  return [v[0] / size, v[1] / size, v[2] / size];
};
const plus = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [
  ax + bx,
  ay + by,
  az + bz,
];
const minus = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [
  ax - bx,
  ay - by,
  az - bz,
];
const times = ([x, y, z]: Vec3, k: number): Vec3 => [x * k, y * k, z * k];
const dot = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3) =>
  ax * bx + ay * by + az * bz;
const cross = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [
  ay * bz - az * by,
  az * bx - ax * bz,
  ax * by - ay * bx,
];

/** The shortest turn from one direction to another (both unit length). */
function turnBetween(from: Vec3, to: Vec3): Quat {
  const [x, y, z] = cross(from, to);
  const w = 1 + dot(from, to);
  const size = Math.hypot(x, y, z, w) || 1;
  return [x / size, y / size, z / size, w / size];
}

/** A turn about x alone, as a quaternion. */
const pitch = (angle: number): Quat => [
  Math.sin(angle / 2),
  0,
  0,
  Math.cos(angle / 2),
];

/** `a × b`, as three.js multiplies: turns by `b`, then by `a`. */
function multiply([ax, ay, az, aw]: Quat, [bx, by, bz, bw]: Quat): Quat {
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const inverse = ([x, y, z, w]: Quat): Quat => [-x, -y, -z, w];

/** A direction turned by a quaternion. */
const rotate = (q: Quat, [x, y, z]: Vec3): Vec3 => {
  const [qx, qy, qz] = multiply(multiply(q, [x, y, z, 0]), inverse(q));
  return [qx, qy, qz];
};

/** A quaternion as Euler angles in three.js's default XYZ order. */
function eulerXYZ([x, y, z, w]: Quat): Vec3 {
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(clamp(m13, -1, 1));
  return Math.abs(m13) < 0.9999999
    ? [Math.atan2(-m23, m33), ry, Math.atan2(-m12, m11)]
    : [Math.atan2(m32, m22), ry, 0];
}

/** Where a joint is in a pose that turns the bones on its way about x alone. */
const jointAt = (rig: Rig, pose: Pose, bone: BoneName): Vec3 => {
  const [y, z] = jointYZ(rig, pose, bone);
  return [rig.joints[bone][0], y, z];
};

/** A hanging limb's direction at rest: every bone's rest rotation is none. */
const down: Vec3 = [0, -1, 0];

/**
 * Leaning back in the chair with the hands clasped behind the head, the
 * elbows out wide: an Agent waiting on review (FR-62). The arms are solved
 * for each body, so the hands meet behind every Avatar's head, whatever
 * its height and build.
 */
export function waitingPose(rig: Rig): Pose {
  const leaning = adjust(seatedPose(rig), {
    spine: [-0.12, 0, 0],
    chest: [-0.06, 0, 0],
    neck: [0.06, 0, 0],
    head: [0.08, 0, 0],
  });
  const s = rig.scale;
  // The torso's turn, which the shoulders (and so the arms' parents) share.
  const torso = pitch(pitchTo(leaning, "chest"));
  const head = pitchTo(leaning, "head");
  const neck = jointAt(rig, leaning, "head");
  // The head's centre and back, turned with it.
  const fromNeck = minus(rig.head.centre, rig.joints.head);
  const headCentre = plus(neck, rotate(pitch(head), fromNeck));
  const rotations: Partial<Record<BoneName, Vec3>> = { ...leaning.rotations };
  for (const side of ["left", "right"] as const) {
    const out = side === "left" ? 1 : -1;
    const shoulder = jointAt(rig, leaning, `${side}UpperArm`);
    // The wrists just behind the head, clear of it, a little apart.
    const wrist = plus(headCentre, [
      out * rig.head.radii[0] * 0.55,
      0.01 * s,
      -(rig.head.radii[2] + rig.limbRadii.forearm + 0.015 * s),
    ]);
    const reach = minus(wrist, shoulder);
    const distance = clamp(
      length(reach),
      Math.abs(rig.upperArmLength - rig.forearmLength) + 1e-3,
      rig.upperArmLength + rig.forearmLength - 1e-3,
    );
    // The elbow is where the upper arm and forearm meet: `ahead` along the
    // line to the wrist and `aside` from it, towards the pole.
    const line = unit(reach);
    const ahead =
      (rig.upperArmLength ** 2 - rig.forearmLength ** 2 + distance ** 2) /
      (2 * distance);
    const aside = Math.sqrt(Math.max(rig.upperArmLength ** 2 - ahead ** 2, 0));
    const pole: Vec3 = [out, 0.2, 0.05];
    const away = unit(minus(pole, times(line, dot(pole, line))));
    const elbow = plus(shoulder, plus(times(line, ahead), times(away, aside)));
    // Each bone turned from hanging down to its direction, in its parent's space.
    const upperWorld = turnBetween(down, unit(minus(elbow, shoulder)));
    const forearmLocal = turnBetween(
      down,
      rotate(inverse(upperWorld), unit(minus(wrist, elbow))),
    );
    rotations[`${side}UpperArm`] = eulerXYZ(
      multiply(inverse(torso), upperWorld),
    );
    rotations[`${side}Forearm`] = eulerXYZ(forearmLocal);
    // The hands curl in behind the head, towards each other.
    rotations[`${side}Hand`] = [0, 0, out * 0.5];
  }
  return { rotations, hips: leaning.hips };
}

/**
 * A squat that keeps the feet where they stand: the hips `drop` lower and
 * `back` behind, the knees solved to follow.
 */
function squat(
  rig: Rig,
  drop: number,
  back: number,
): Partial<Record<BoneName, Vec3>> {
  const hip: readonly [number, number] = [
    rig.joints.leftThigh[1] - drop,
    -back,
  ];
  const ankle: readonly [number, number] = [rig.joints.leftFoot[1], 0];
  const leg = twoBone(hip, ankle, rig.thighLength, rig.shinLength, -1);
  const thigh = -leg.upper;
  const shin = -(leg.lower - leg.upper);
  const foot = leg.lower;
  return {
    leftThigh: [thigh, 0, 0],
    rightThigh: [thigh, 0, 0],
    leftShin: [shin, 0, 0],
    rightShin: [shin, 0, 0],
    leftFoot: [foot, 0, 0],
    rightFoot: [foot, 0, 0],
  };
}

/**
 * `base` with the knees bent: the hips `drop` lower and `back` behind,
 * the feet kept where they stand, for a ready stance or a lift.
 */
function crouched(rig: Rig, base: Pose, drop: number, back: number): Pose {
  return {
    rotations: { ...base.rotations, ...squat(rig, drop, back) },
    hips: [base.hips[0], base.hips[1] - drop, base.hips[2] - back],
  };
}

/** A walking stride's legs and arms at its first contact, left leg forwards. */
function stride(rig: Rig, swing: number): Pose[] {
  const base = standingPose(rig);
  const s = rig.scale;
  const contact = (side: 1 | -1): Pose => {
    const [front, back] =
      side === 1 ? (["left", "right"] as const) : (["right", "left"] as const);
    return adjust(
      base,
      {
        [`${front}Thigh`]: [-0.42, 0, 0],
        [`${front}Shin`]: [0.06, 0, 0],
        [`${front}Foot`]: [0.2, 0, 0],
        [`${back}Thigh`]: [0.34, 0, 0],
        [`${back}Shin`]: [0.3, 0, 0],
        [`${back}Foot`]: [-0.42, 0, 0],
        [`${front}UpperArm`]: [swing, 0, 0],
        [`${back}UpperArm`]: [-swing, 0, 0],
        chest: [0, side * 0.08, 0],
        hips: [0, -side * 0.06, 0],
      },
      [0, -0.018 * s, 0],
    );
  };
  const passing = (side: 1 | -1): Pose => {
    const [standing, lifting] =
      side === 1 ? (["left", "right"] as const) : (["right", "left"] as const);
    return adjust(
      base,
      {
        [`${standing}Thigh`]: [-0.04, 0, 0],
        [`${standing}Shin`]: [0.08, 0, 0],
        [`${standing}Foot`]: [-0.04, 0, 0],
        [`${lifting}Thigh`]: [-0.25, 0, 0],
        [`${lifting}Shin`]: [0.72, 0, 0],
        [`${lifting}Foot`]: [-0.2, 0, 0],
      },
      [0, 0.012 * s, 0],
    );
  };
  return [contact(1), passing(1), contact(-1), passing(-1)];
}

/** The arms holding a ticket out in front in both hands (FR-59). */
const ticketHold = {
  leftUpperArm: [-0.5, 0, -0.1],
  rightUpperArm: [-0.5, 0, 0.1],
  leftForearm: [-1.0, 0, 0],
  rightForearm: [-1.0, 0, 0],
  leftHand: [0.1, 0, 0],
  rightHand: [0.1, 0, 0],
} as const satisfies Partial<Record<BoneName, Vec3>>;

/** One key every `step` seconds, from 0. */
const every = (step: number, poses: readonly Pose[]): PoseKey[] =>
  poses.map((pose, index) => ({ time: index * step, pose }));

/** The animation `name`, for an Avatar on `rig`. */
export function animationSpec(name: AnimationName, rig: Rig): AnimationSpec {
  const standing = standingPose(rig);
  const seated = seatedPose(rig);
  const s = rig.scale;
  switch (name) {
    case "idle":
      // Breathing, weight shifting, a glance aside.
      return {
        name,
        duration: 4,
        loop: true,
        seated: false,
        keys: [
          { time: 0, pose: standing },
          {
            time: 1.4,
            pose: adjust(
              standing,
              { chest: [-0.03, 0, 0], head: [0, 0.18, 0] },
              [0.008 * s, 0.004 * s, 0],
            ),
          },
          {
            time: 2.8,
            pose: adjust(
              standing,
              { chest: [-0.015, 0, 0], head: [0.04, -0.06, 0] },
              [-0.006 * s, 0, 0],
            ),
          },
        ],
      };
    case "sit":
      return {
        name,
        duration: 4,
        loop: true,
        seated: true,
        keys: [
          { time: 0, pose: seated },
          {
            time: 1.6,
            pose: adjust(seated, {
              chest: [-0.025, 0, 0],
              head: [-0.04, 0.2, 0],
            }),
          },
          {
            time: 2.8,
            pose: adjust(seated, {
              chest: [-0.01, 0, 0],
              head: [0.05, 0.05, 0],
            }),
          },
        ],
      };
    case "type": {
      const typing = typingPose(rig);
      const tap = (left: number, right: number, look: number) =>
        adjust(typing, {
          leftHand: [left, 0, 0],
          rightHand: [right, 0, 0],
          leftForearm: [-left * 0.3, 0, 0],
          rightForearm: [-right * 0.3, 0, 0],
          head: [0, look, 0],
        });
      return {
        name,
        duration: 1.2,
        loop: true,
        seated: true,
        keys: every(0.15, [
          tap(0.14, -0.04, 0),
          tap(-0.04, 0.12, 0.01),
          tap(0.1, 0, 0.02),
          tap(0, 0.15, 0.02),
          tap(0.12, -0.02, 0.01),
          tap(-0.03, 0.1, 0),
          tap(0.08, 0.06, -0.01),
          tap(0, 0.12, -0.01),
        ]),
      };
    }
    case "walk":
      return {
        name,
        duration: 1,
        loop: true,
        seated: false,
        keys: every(0.25, stride(rig, -0.32)),
      };
    case "run":
      // A walk's stride, quicker and with the arms pumping.
      return {
        name,
        duration: 0.6,
        loop: true,
        seated: false,
        keys: every(0.15, stride(rig, -0.75)),
      };
    case "hop": {
      // Feet together, crouching then springing up and landing again.
      const crouch = adjust(
        standing,
        {
          leftThigh: [-0.5, 0, 0],
          rightThigh: [-0.5, 0, 0],
          leftShin: [0.8, 0, 0],
          rightShin: [0.8, 0, 0],
          leftFoot: [-0.3, 0, 0],
          rightFoot: [-0.3, 0, 0],
          leftUpperArm: [0.3, 0, 0],
          rightUpperArm: [0.3, 0, 0],
        },
        [0, -0.12 * s, 0],
      );
      const flying = adjust(
        standing,
        {
          leftFoot: [0.35, 0, 0],
          rightFoot: [0.35, 0, 0],
          leftUpperArm: [-0.5, 0, 0.2],
          rightUpperArm: [-0.5, 0, -0.2],
        },
        [0, 0.22 * s, 0],
      );
      return {
        name,
        duration: 0.7,
        loop: true,
        seated: false,
        keys: [
          { time: 0, pose: crouch },
          { time: 0.3, pose: flying },
          { time: 0.55, pose: standing },
        ],
      };
    }
    case "scare": {
      // Arms up and out, leaning in: boo!
      const looming = adjust(
        standing,
        {
          chest: [0.18, 0, 0],
          head: [0.12, 0, 0],
          leftUpperArm: [-2.3, 0, 0.5],
          rightUpperArm: [-2.3, 0, -0.5],
          leftForearm: [-0.5, 0, 0],
          rightForearm: [-0.5, 0, 0],
        },
        [0, 0, 0.04 * s],
      );
      return {
        name,
        duration: 1.2,
        loop: true,
        seated: false,
        keys: [
          { time: 0, pose: looming },
          {
            time: 0.6,
            pose: adjust(looming, { chest: [0.28, 0.15, 0] }),
          },
        ],
      };
    }
    case "stagger":
      // A slow walk, lurching from side to side, one arm out for balance.
      return {
        name,
        duration: 1.6,
        loop: true,
        seated: false,
        keys: every(
          0.4,
          stride(rig, -0.2).map((pose, index) => {
            const lean = index % 2 === 0 ? 1 : -1;
            return adjust(
              pose,
              {
                chest: [0.08, 0.1 * lean, 0.18 * lean],
                head: [0.1, -0.15 * lean, -0.22 * lean],
                leftUpperArm: [0, 0, 0.7],
              },
              [0.07 * lean * s, -0.02 * s, 0],
            );
          }),
        ),
      };
    case "sway": {
      // Standing, swaying round and round, a glass raised: cheers!
      const raised = adjust(standing, {
        rightUpperArm: [-1.6, 0, -0.2],
        rightForearm: [-0.6, 0, 0],
      });
      const leaning = (side: number, forward: number) =>
        adjust(
          raised,
          {
            chest: [0.06 * forward, 0, 0.16 * side],
            head: [0.12, 0.1 * side, -0.2 * side],
            leftUpperArm: [0, 0, 0.4 + 0.2 * side],
          },
          [0.05 * side * s, 0, 0.03 * forward * s],
        );
      return {
        name,
        duration: 2.4,
        loop: true,
        seated: false,
        keys: every(0.6, [
          leaning(1, 0),
          leaning(0, 1),
          leaning(-1, 0),
          leaning(0, -1),
        ]),
      };
    }
    case "float": {
      // Off the ground, bobbing up and down, the legs trailing and the
      // arms held out in front: only the ghost goes round like this.
      const drifting = (rise: number, trail: number) =>
        adjust(
          standing,
          {
            leftThigh: [0.15 + trail, 0, 0],
            rightThigh: [0.2 + trail, 0, 0],
            leftShin: [0.25, 0, 0],
            rightShin: [0.3, 0, 0],
            leftFoot: [0.4, 0, 0],
            rightFoot: [0.4, 0, 0],
            leftUpperArm: [-1.3, 0, -0.15],
            rightUpperArm: [-1.3, 0, 0.15],
            leftForearm: [-0.2, 0, 0],
            rightForearm: [-0.2, 0, 0],
            chest: [0.08, 0, 0],
          },
          [0, rise * s, 0],
        );
      return {
        name,
        duration: 1.8,
        loop: true,
        seated: false,
        keys: every(0.6, [
          drifting(0.18, 0),
          drifting(0.3, 0.08),
          drifting(0.24, 0.04),
        ]),
      };
    }
    case "carry": {
      // Walking with a ticket held out in front in both hands (FR-59).
      return {
        name,
        duration: 1,
        loop: true,
        seated: false,
        prop: "ticket",
        keys: every(
          0.25,
          stride(rig, 0).map((pose) => ({
            hips: pose.hips,
            rotations: { ...pose.rotations, ...ticketHold },
          })),
        ),
      };
    }
    case "hand-over": {
      // Holding the ticket out, then reaching forwards to give it to the
      // next Agent, with a nod (FR-59). It ends as the ticket leaves the
      // hand.
      const holding: Pose = {
        hips: standing.hips,
        rotations: { ...standing.rotations, ...ticketHold },
      };
      const reaching = adjust(holding, {
        leftUpperArm: [-0.6, 0, 0],
        rightUpperArm: [-0.6, 0, 0],
        leftForearm: [0.75, 0, 0],
        rightForearm: [0.75, 0, 0],
        chest: [0.1, 0, 0],
      });
      return {
        name,
        duration: 1,
        loop: false,
        seated: false,
        prop: "ticket",
        keys: [
          { time: 0, pose: holding },
          { time: 0.6, pose: reaching },
          { time: 1, pose: adjust(reaching, { head: [0.18, 0, 0] }) },
        ],
      };
    }
    case "sit-down": {
      // Standing up, played backwards: back into the chair after a walk.
      const up = animationSpec("stand-up", rig);
      return {
        ...up,
        name,
        keys: up.keys
          .map(({ time, pose }) => ({ time: up.duration - time, pose }))
          .reverse(),
      };
    }
    case "stand-up": {
      const leaning = adjust(
        seated,
        { spine: [0.45, 0, 0], chest: [0.15, 0, 0], head: [-0.2, 0, 0] },
        [0, 0, 0.06 * s],
      );
      const rising = adjust(
        {
          rotations: {
            ...standing.rotations,
            ...squat(rig, (seatHeight + 0.1) * 0.35, 0.12 * s),
          },
          hips: still,
        },
        { spine: [0.32, 0, 0], chest: [0.08, 0, 0], head: [-0.15, 0, 0] },
        [0, -(seatHeight + 0.1) * 0.35, -0.12 * s],
      );
      return {
        name,
        duration: 1.2,
        loop: false,
        seated: true,
        keys: [
          { time: 0, pose: seated },
          { time: 0.4, pose: leaning },
          { time: 0.8, pose: rising },
          { time: 1.2, pose: standing },
        ],
      };
    }
    case "stretch": {
      const reach = adjust(standing, {
        leftUpperArm: [0, 0, 2.55],
        rightUpperArm: [0, 0, -2.55],
        leftForearm: [0.12, 0, 0.25],
        rightForearm: [0.12, 0, -0.25],
        spine: [-0.06, 0, 0],
        chest: [-0.14, 0, 0],
        head: [-0.25, 0, 0],
      });
      return {
        name,
        duration: 3.2,
        loop: true,
        seated: false,
        keys: [
          { time: 0, pose: standing },
          { time: 1, pose: reach },
          {
            time: 1.6,
            pose: adjust(reach, { spine: [0, 0, 0.08], chest: [0, 0, 0.06] }),
          },
          {
            time: 2.2,
            pose: adjust(reach, { spine: [0, 0, -0.08], chest: [0, 0, -0.06] }),
          },
        ],
      };
    }
    case "sleep": {
      // Leaning back in the chair, the head tipped back (FR-61).
      const asleep = adjust(seated, {
        spine: [-0.16, 0, 0],
        chest: [-0.1, 0, 0],
        neck: [-0.08, 0, 0],
        head: [-0.32, 0.12, 0.08],
        leftUpperArm: [0.2, 0, 0.05],
        rightUpperArm: [0.2, 0, -0.05],
        leftForearm: [0.3, 0, 0],
        rightForearm: [0.3, 0, 0],
      });
      return {
        name,
        duration: 4.4,
        loop: true,
        seated: true,
        keys: [
          { time: 0, pose: asleep },
          {
            time: 2.2,
            pose: adjust(asleep, { chest: [-0.04, 0, 0], head: [-0.03, 0, 0] }),
          },
        ],
      };
    }
    case "drink": {
      // A mug held in the right hand, raised to sip (FR-61's coffee).
      const holding = adjust(standing, {
        rightUpperArm: [-0.35, 0, 0.12],
        rightForearm: [-1.2, 0, 0],
        rightHand: [0.15, 0, 0],
      });
      const sipping = adjust(holding, {
        rightUpperArm: [-0.25, 0, 0.18],
        rightForearm: [-0.95, 0, 0],
        rightHand: [0.2, 0, 0],
        head: [-0.22, 0, 0],
        neck: [-0.06, 0, 0],
      });
      return {
        name,
        duration: 4,
        loop: true,
        seated: false,
        prop: "mug",
        keys: [
          { time: 0, pose: holding },
          { time: 1.1, pose: sipping },
          { time: 2.1, pose: adjust(sipping, { head: [-0.04, 0, 0] }) },
          { time: 3, pose: holding },
        ],
      };
    }
    case "work-out": {
      // Squats in the gym, the arms out in front for balance (FR-61).
      const arms = adjust(standing, {
        leftUpperArm: [-1.45, 0, -0.1],
        rightUpperArm: [-1.45, 0, 0.1],
        leftForearm: [0.12, 0, 0],
        rightForearm: [0.12, 0, 0],
      });
      // Solved at several depths, so the feet stay put between keys too.
      const depth = (share: number): Pose =>
        adjust(
          {
            rotations: {
              ...arms.rotations,
              ...squat(rig, 0.3 * s * share, 0.12 * s * share),
            },
            hips: still,
          },
          {
            spine: [0.32 * share, 0, 0],
            chest: [0.08 * share, 0, 0],
            head: [-0.3 * share, 0, 0],
          },
          [0, -0.3 * s * share, -0.12 * s * share],
        );
      return {
        name,
        duration: 2,
        loop: true,
        seated: false,
        keys: (
          [
            [0, 0],
            [0.3, 0.35],
            [0.6, 0.8],
            [0.9, 1],
            [1.2, 1],
            [1.5, 0.6],
            [1.75, 0.2],
          ] as const
        ).map(([time, share]) => ({ time, pose: depth(share) })),
      };
    }
    case "wait": {
      // Waiting on review (FR-62): leaning back, hands behind the head,
      // glancing over now and then, as if towards the reviewers.
      const waiting = waitingPose(rig);
      return {
        name,
        duration: 6,
        loop: true,
        seated: true,
        keys: [
          { time: 0, pose: waiting },
          {
            time: 2,
            pose: adjust(waiting, { neck: [0, 0.1, 0], head: [0.04, 0.16, 0] }),
          },
          {
            time: 3.4,
            pose: adjust(waiting, {
              neck: [0, 0.08, 0],
              head: [0.03, 0.14, 0],
            }),
          },
          {
            time: 4.6,
            pose: adjust(waiting, {
              chest: [-0.02, 0, 0],
              head: [-0.03, -0.05, 0],
            }),
          },
        ],
      };
    }
    case "throw": {
      // Darts at the oche (FR-61): side on to the board, the dart raised
      // by the eye, drawn back, thrown with a flick of the forearm, the
      // arm following through and then lowered for the next. Its partner
      // plays it half a loop later, so they take turns.
      const stance = adjust(standing, {
        chest: [0, -0.15, 0],
        head: [0.04, 0.12, 0],
        leftUpperArm: [-0.2, 0, 0.1],
      });
      const aim = adjust(stance, {
        rightUpperArm: [-1.35, 0, 0.25],
        rightForearm: [-1.25, 0, 0],
        rightHand: [0.15, 0, 0],
      });
      return {
        name,
        duration: 2.4,
        loop: true,
        seated: false,
        prop: "dart",
        keys: [
          { time: 0, pose: aim },
          { time: 0.7, pose: adjust(aim, { head: [0.03, 0, 0] }) },
          { time: 1, pose: adjust(aim, { rightForearm: [-0.45, 0, 0] }) },
          {
            time: 1.2,
            pose: adjust(aim, {
              rightForearm: [1.1, 0, 0],
              rightHand: [-0.45, 0, 0],
              chest: [0.06, 0, 0],
            }),
          },
          {
            time: 1.5,
            pose: adjust(aim, {
              rightUpperArm: [0.15, 0, 0],
              rightForearm: [1.2, 0, 0],
              rightHand: [-0.3, 0, 0],
            }),
          },
          {
            time: 2,
            pose: adjust(stance, {
              rightUpperArm: [-0.7, 0, 0.15],
              rightForearm: [-1.1, 0, 0],
            }),
          },
        ],
      };
    }
    case "swing": {
      // Table tennis (FR-61): a ready stance, the knees bent, the bat
      // drawn back, then a forehand swept across, and back to ready. The
      // bat meets the ball at `batMeetsBall`; the Agent at the other end
      // plays the loop half a turn later, as the ball reaches it.
      const ready = adjust(crouched(rig, standing, 0.03 * s, 0.07 * s), {
        spine: [0.3, 0, 0],
        head: [-0.15, 0, 0],
        leftUpperArm: [-0.5, 0, 0.1],
        leftForearm: [-0.9, 0, 0],
        rightUpperArm: [-0.55, 0, -0.2],
        rightForearm: [-0.8, 0, 0],
      });
      return {
        name,
        duration: rally.seconds,
        loop: true,
        seated: false,
        prop: "bat",
        keys: [
          {
            time: 0,
            pose: adjust(ready, {
              chest: [0, -0.45, 0],
              rightUpperArm: [0.35, 0, -0.35],
            }),
          },
          {
            time: rally.batMeetsBall,
            pose: adjust(ready, {
              rightUpperArm: [-0.45, 0, -0.05],
              rightForearm: [-0.25, 0, 0],
            }),
          },
          {
            time: 0.45,
            pose: adjust(ready, {
              chest: [0, 0.4, 0],
              rightUpperArm: [-0.75, 0, 0.45],
              rightForearm: [-0.6, 0, 0],
            }),
          },
          { time: 0.9, pose: ready },
          {
            time: 1.25,
            pose: adjust(ready, { chest: [0, -0.15, 0], head: [0, -0.1, 0] }),
          },
        ],
      };
    }
    case "lift": {
      // Lifting weights (FR-61): dumbbell curls, the elbow at the side,
      // the weight brought up to the shoulder and lowered under control.
      const braced = adjust(standing, {
        rightUpperArm: [0.05, 0, 0.12],
        leftUpperArm: [0.05, 0, -0.05],
      });
      const curled = (share: number): Pose =>
        adjust(braced, {
          rightForearm: [-2.1 * share, 0, 0],
          rightHand: [-0.3 * share, 0, 0],
          spine: [-0.05 * share, 0, 0],
          head: [-0.06 * share, 0, 0],
        });
      return {
        name,
        duration: 3.2,
        loop: true,
        seated: false,
        prop: "dumbbell",
        keys: (
          [
            [0, 0],
            [0.6, 0.9],
            [0.8, 1],
            [1.6, 0],
            [2.2, 0.9],
            [2.4, 1],
          ] as const
        ).map(([time, share]) => ({ time, pose: curled(share) })),
      };
    }
    case "foosball": {
      // Foosball (FR-61): leaning over the table, a rod in each hand at
      // the waist, the wrists spinning them and the body jinking.
      const over = adjust(crouched(rig, standing, 0.02 * s, 0.06 * s), {
        spine: [0.22, 0, 0],
        head: [-0.15, 0, 0],
        leftUpperArm: [-0.75, 0, -0.1],
        rightUpperArm: [-0.75, 0, 0.1],
        leftForearm: [-0.55, 0, 0],
        rightForearm: [-0.55, 0, 0],
      });
      const spin = (left: number, right: number, sway: number) =>
        adjust(over, {
          leftForearm: [0, left, 0],
          rightForearm: [0, right, 0],
          leftHand: [left * 0.4, 0, 0],
          rightHand: [right * 0.4, 0, 0],
          chest: [0, sway, 0],
          hips: [0, sway * 0.5, 0],
        });
      return {
        name,
        duration: 1.2,
        loop: true,
        seated: false,
        keys: every(0.2, [
          spin(0, 0, 0),
          spin(0.6, -0.2, 0.1),
          spin(-0.4, 0.7, -0.08),
          spin(0.2, -0.6, 0.06),
          spin(-0.7, 0.3, -0.1),
          spin(0.1, 0.1, 0.02),
        ]),
      };
    }
    case "pool": {
      // Pool (FR-61): bent low over the table, the left hand bridging
      // ahead, the cue level from the right hand by the hip, drawn back
      // and forth twice, then struck through and held. Each bone's turn
      // is from its parent's, so the torso's lean is taken off the arms'.
      const lean = 1.1;
      const elbowBack = 0.55;
      const over = adjust(crouched(rig, standing, 0.015 * s, 0.11 * s), {
        spine: [0.65, 0, 0],
        chest: [lean - 0.65, 0, 0],
        neck: [-0.35, 0, 0],
        head: [-0.5, 0, 0],
        leftUpperArm: [-1.4 - lean, 0, -0.25],
        leftForearm: [0.12, 0, 0],
        leftHand: [0.35, 0, 0],
        rightUpperArm: [elbowBack - lean, 0, 0.1],
      });
      // The forearm swings from the elbow, `swing` from hanging straight
      // down; the hand keeps the cue level, pointing ahead.
      const stroke = (swing: number) =>
        adjust(over, {
          rightForearm: [swing - elbowBack + 0.12, 0, 0],
          rightHand: [-Math.PI / 2 - swing, 0, 0],
        });
      return {
        name,
        duration: 3,
        loop: true,
        seated: false,
        prop: "cue",
        keys: [
          { time: 0, pose: stroke(0) },
          { time: 0.5, pose: stroke(0.35) },
          { time: 0.9, pose: stroke(-0.2) },
          { time: 1.3, pose: stroke(0.4) },
          { time: 1.55, pose: stroke(-0.45) },
          { time: 2.4, pose: stroke(-0.4) },
        ],
      };
    }
    case "shoot": {
      // Shooting hoops (FR-61): a dip at the knees with the ball at the
      // chest, then up, the arms extending overhead and the wrists
      // flicking, held for the follow-through.
      const set = adjust(crouched(rig, standing, 0.16 * s, 0.08 * s), {
        spine: [0.12, 0, 0],
        head: [-0.25, 0, 0],
        leftUpperArm: [-1.0, 0, -0.1],
        rightUpperArm: [-1.0, 0, 0.1],
        leftForearm: [-1.7, 0, 0],
        rightForearm: [-1.7, 0, 0],
      });
      const release = adjust(standing, {
        head: [-0.35, 0, 0],
        leftUpperArm: [-2.6, 0, -0.1],
        rightUpperArm: [-2.7, 0, 0.1],
        leftForearm: [-0.25, 0, 0],
        rightForearm: [-0.2, 0, 0],
        leftHand: [-0.6, 0, 0],
        rightHand: [-0.7, 0, 0],
      });
      return {
        name,
        duration: 2.4,
        loop: true,
        seated: false,
        keys: [
          { time: 0, pose: adjust(standing, { head: [-0.2, 0, 0] }) },
          { time: 0.5, pose: set },
          { time: 0.85, pose: release },
          {
            time: 1.4,
            pose: adjust(release, {
              leftHand: [0.2, 0, 0],
              rightHand: [0.2, 0, 0],
            }),
          },
          {
            time: 1.9,
            pose: adjust(standing, {
              head: [-0.15, 0, 0],
              leftUpperArm: [-0.4, 0, 0],
              rightUpperArm: [-0.4, 0, 0],
            }),
          },
        ],
      };
    }
    case "putt": {
      // Putting (FR-61): bent over the ball, the arms hanging together
      // with the putter, swinging back and through like a pendulum, then
      // watching the ball roll.
      const address = adjust(crouched(rig, standing, 0.015 * s, 0.09 * s), {
        spine: [0.35, 0, 0],
        chest: [0.15, 0, 0],
        head: [0.2, 0, 0],
        leftUpperArm: [-0.45, 0, -0.32],
        rightUpperArm: [-0.45, 0, 0.32],
        leftForearm: [-0.15, 0, 0],
        rightForearm: [-0.15, 0, 0],
      });
      const swing = (by: number) =>
        adjust(address, {
          leftUpperArm: [by, 0, 0],
          rightUpperArm: [by, 0, 0],
          chest: [0, by * 0.3, 0],
        });
      return {
        name,
        duration: 3,
        loop: true,
        seated: false,
        prop: "putter",
        keys: [
          { time: 0, pose: swing(0) },
          { time: 0.8, pose: swing(0.3) },
          { time: 1.3, pose: swing(-0.32) },
          { time: 2.2, pose: adjust(swing(-0.3), { head: [0, 0.35, 0] }) },
        ],
      };
    }
    case "pedal": {
      // On the exercise bike (FR-61): sat back on its seat, the hands on
      // its grips, the legs turning the pedals one after the other.
      const riding = adjust(seated, {
        spine: [0.08, 0, 0],
        leftUpperArm: [-0.25, 0, 0],
        rightUpperArm: [-0.25, 0, 0],
        leftForearm: [-0.35, 0, 0],
        rightForearm: [-0.35, 0, 0],
      });
      const legs = (left: number, right: number) =>
        adjust(riding, {
          leftThigh: [-0.35 * left, 0, 0],
          leftShin: [0.5 * left, 0, 0],
          rightThigh: [-0.35 * right, 0, 0],
          rightShin: [0.5 * right, 0, 0],
        });
      return {
        name,
        duration: 1.2,
        loop: true,
        seated: true,
        keys: every(0.3, [
          legs(1, 0),
          legs(0.5, 0.5),
          legs(0, 1),
          legs(0.5, 0.5),
        ]),
      };
    }
    case "row": {
      // On the rowing machine (FR-61): at the catch, leaning in with the
      // arms reaching; the drive, leaning back as the hands pull the
      // handle to the chest; and the recovery, forwards again.
      const reach = adjust(seated, {
        spine: [0.35, 0, 0],
        chest: [0.1, 0, 0],
        head: [-0.3, 0, 0],
        leftUpperArm: [-1.1, 0, -0.1],
        rightUpperArm: [-1.1, 0, 0.1],
        leftForearm: [0.75, 0, 0],
        rightForearm: [0.75, 0, 0],
        leftThigh: [-0.3, 0, 0],
        rightThigh: [-0.3, 0, 0],
        leftShin: [0.25, 0, 0],
        rightShin: [0.25, 0, 0],
      });
      const pulled = adjust(seated, {
        spine: [-0.25, 0, 0],
        head: [0.2, 0, 0],
        leftUpperArm: [0.3, 0, 0.1],
        rightUpperArm: [0.3, 0, -0.1],
        leftForearm: [-1.25, 0, 0],
        rightForearm: [-1.25, 0, 0],
        leftShin: [-0.35, 0, 0],
        rightShin: [-0.35, 0, 0],
      });
      return {
        name,
        duration: 2.4,
        loop: true,
        seated: true,
        keys: [
          { time: 0, pose: reach },
          { time: 0.8, pose: pulled },
          { time: 1.1, pose: adjust(pulled, { spine: [0.05, 0, 0] }) },
        ],
      };
    }
    case "punch": {
      // At the punchbag (FR-61): fists up in a guard, jabbing with the
      // left, crossing with the right, turning from the waist.
      const guard = adjust(crouched(rig, standing, 0.03 * s, 0.04 * s), {
        spine: [0.1, 0, 0],
        head: [-0.1, 0, 0],
        leftUpperArm: [-0.85, 0, -0.25],
        rightUpperArm: [-0.85, 0, 0.25],
        leftForearm: [-1.9, 0, 0],
        rightForearm: [-1.9, 0, 0],
      });
      const jab = adjust(guard, {
        chest: [0, -0.25, 0],
        leftUpperArm: [-0.7, 0, 0.2],
        leftForearm: [1.75, 0, 0],
      });
      const cross = adjust(guard, {
        chest: [0, 0.35, 0],
        rightUpperArm: [-0.7, 0, -0.2],
        rightForearm: [1.75, 0, 0],
      });
      return {
        name,
        duration: 1.6,
        loop: true,
        seated: false,
        keys: [
          { time: 0, pose: guard },
          { time: 0.2, pose: jab },
          { time: 0.45, pose: guard },
          { time: 0.75, pose: cross },
          { time: 1.05, pose: guard },
          { time: 1.25, pose: jab },
        ],
      };
    }
    case "chat":
      // Talking at the water cooler, hands moving (FR-61).
      return {
        name,
        duration: 3,
        loop: true,
        seated: false,
        keys: [
          {
            time: 0,
            pose: adjust(standing, {
              rightUpperArm: [-0.35, 0, 0.1],
              rightForearm: [-1.1, 0, 0],
              head: [0, 0.12, 0],
            }),
          },
          {
            time: 0.7,
            pose: adjust(standing, {
              rightUpperArm: [-0.45, 0, 0.05],
              rightForearm: [-1.35, 0.4, 0],
              rightHand: [0, 0, 0.3],
              head: [0.08, 0.1, 0],
            }),
          },
          {
            time: 1.5,
            pose: adjust(standing, {
              leftUpperArm: [-0.4, 0, -0.1],
              leftForearm: [-1.2, -0.3, 0],
              rightUpperArm: [-0.1, 0, 0],
              head: [-0.04, 0.2, 0],
            }),
          },
          {
            time: 2.3,
            pose: adjust(standing, {
              leftUpperArm: [-0.25, 0, -0.05],
              leftForearm: [-0.9, 0, 0],
              rightUpperArm: [-0.3, 0, 0.08],
              rightForearm: [-1.0, 0, 0],
              head: [0.1, 0.08, 0],
            }),
          },
        ],
      };
  }
}
