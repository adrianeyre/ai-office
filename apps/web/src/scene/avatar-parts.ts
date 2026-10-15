import type { Avatar, DeskItemKind } from "@ai-office/shared/avatar";
import type { PaletteToken } from "@ai-office/shared/palette";

import type { Vec3 } from "./camera-rig.ts";
import { avatarRig, type BoneName, type Rig } from "./avatar-rig.ts";

// The character kit (PRD FR-13, §7): an Avatar as simple, rounded shapes on
// the shared rig, one part for every option of the Avatar Editor, each
// tinted from the Avatar's colours. Like the Office's pieces it is our own,
// built in code from a few shapes at real size, so the kit needs no asset
// pack and every part fits every body. It is data only, without three.js:
// avatar-geometry.ts turns the shapes into one skinned mesh.
//
// Every shape is in the model's space at rest (avatar-rig.ts), bound to one
// bone; a skirt is shared between the hips and the thighs, so it follows
// the legs when the Avatar sits.

/** The Avatar's own colours, which the kit's parts are tinted with. */
export type AvatarSlot = "skin" | "hair" | "primary" | "secondary";

/**
 * A shape's colour: one of the Avatar's, a mix of two (stubble is skin
 * and hair), a palette token, or one of the Avatar swatches (shoes, gold).
 */
export type Tint =
  | AvatarSlot
  | PaletteToken
  | { readonly mix: readonly [AvatarSlot, AvatarSlot]; readonly amount: number }
  | { readonly swatch: string };

/**
 * How a surface catches the light. Fabric, plastic and metal are the
 * spec's surfaces; skin and hair are the Avatars' own, between them.
 */
export const avatarFinishes = {
  skin: { metalness: 0, roughness: 0.6 },
  hair: { metalness: 0, roughness: 0.75 },
  fabric: { metalness: 0, roughness: 0.95 },
  plastic: { metalness: 0, roughness: 0.5 },
  metal: { metalness: 1, roughness: 0.4 },
} as const;
export type AvatarFinish = keyof typeof avatarFinishes;

/**
 * How finely a shape is made: the body's large shapes, small ones (hands,
 * feet, hair masses) and tiny ones (eyes, ears, frames) with fewer sides.
 */
export type ShapeDetail = "large" | "small" | "tiny";

interface ShapeBase {
  /** What it is, for tests and for people. */
  readonly name: string;
  readonly bone: BoneName;
  readonly tint: Tint;
  readonly finish: AvatarFinish;
  readonly detail: ShapeDetail;
  /** Shared between the hips and the thigh on its side, by height. */
  readonly skirt?: boolean;
}

/** A shape about its centre `at`: scaled, then turned (Euler XYZ, radians). */
interface Placed {
  readonly at: Vec3;
  readonly rotation?: Vec3;
}

export type AvatarShape = ShapeBase &
  (
    | (Placed & {
        readonly kind: "ellipsoid";
        /** Half its width, height and depth. */
        readonly radii: Vec3;
      })
    | (Placed & {
        /**
         * The top of an ellipsoid, open below: down to `cut` of the way
         * from its top to its bottom (0.5 is a half), for hair and caps.
         */
        readonly kind: "dome";
        readonly radii: Vec3;
        readonly cut: number;
      })
    | {
        /** Rounded at both ends, from `from` to `to`, tapering from one radius to the other. */
        readonly kind: "capsule";
        readonly from: Vec3;
        readonly to: Vec3;
        readonly radii: readonly [number, number];
        /** Its depth against its width, across it (1: round). */
        readonly flatten?: number;
      }
    | {
        /** A cone cut flat at both ends, from `from` to `to`: a skirt, a pot, a cuff. */
        readonly kind: "frustum";
        readonly from: Vec3;
        readonly to: Vec3;
        readonly radii: readonly [number, number];
        readonly flatten?: number;
      }
    | (Placed & { readonly kind: "box"; readonly size: Vec3 })
    | (Placed & {
        /**
         * A ring in the x-y plane: `radius` to the middle of its tube.
         * `sides` around it makes it square (4) or round (more); `arc` of
         * a whole turn, from +x anticlockwise. `scale` stretches it.
         */
        readonly kind: "torus";
        readonly radius: number;
        readonly tube: number;
        readonly sides?: number;
        readonly arc?: number;
        readonly scale?: Vec3;
      })
  );

type Shape = AvatarShape;

/** A shape bound to no bone: a prop's, or a desk mascot's. */
export type UnboundShape = AvatarShape extends infer Each
  ? Each extends AvatarShape
    ? Omit<Each, "bone" | "skirt">
    : never
  : never;

const add = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [
  ax + bx,
  ay + by,
  az + bz,
];
const scaled = ([x, y, z]: Vec3, by: number): Vec3 => [x * by, y * by, z * by];

type LimbPart =
  "Shoulder" | "UpperArm" | "Forearm" | "Hand" | "Thigh" | "Shin" | "Foot";

/** Each side's limbs' bones. */
const limbBones: Readonly<
  Record<"left" | "right", Readonly<Record<LimbPart, BoneName>>>
> = {
  left: {
    Shoulder: "leftShoulder",
    UpperArm: "leftUpperArm",
    Forearm: "leftForearm",
    Hand: "leftHand",
    Thigh: "leftThigh",
    Shin: "leftShin",
    Foot: "leftFoot",
  },
  right: {
    Shoulder: "rightShoulder",
    UpperArm: "rightUpperArm",
    Forearm: "rightForearm",
    Hand: "rightHand",
    Thigh: "rightThigh",
    Shin: "rightShin",
    Foot: "rightFoot",
  },
};

/** The two sides, left (+x) first, each with its sign and bone prefix. */
const sides = [
  { sign: 1, side: "left" },
  { sign: -1, side: "right" },
] as const;

/** Each face's head, against the average: its radii and its jaw. */
const faceShapes: Readonly<
  Record<
    Avatar["face"],
    {
      readonly radii: Vec3;
      /** The lower face: its radii against the head's, and how low it is. */
      readonly jaw: { readonly radii: Vec3; readonly drop: number };
    }
  >
> = {
  oval: { radii: [1, 1, 1], jaw: { radii: [0.8, 0.6, 0.85], drop: 0.38 } },
  round: {
    radii: [1.08, 0.94, 1.04],
    jaw: { radii: [0.92, 0.6, 0.9], drop: 0.32 },
  },
  square: {
    radii: [1.04, 0.98, 1],
    jaw: { radii: [0.97, 0.55, 0.92], drop: 0.36 },
  },
  heart: { radii: [1.06, 1, 1], jaw: { radii: [0.62, 0.62, 0.8], drop: 0.42 } },
  long: {
    radii: [0.94, 1.08, 0.98],
    jaw: { radii: [0.8, 0.64, 0.86], drop: 0.42 },
  },
};

/** Shoes are the darkest outfit swatch, gold the mustard one. */
const shoes: Tint = { swatch: "#2b2b2b" };
const gold: Tint = { swatch: "#d98e04" };

/**
 * The depth (z radius) a shell of height `height` (y radius) needs, tilted
 * by `tilt` about x, to cover a head of radii `head` (y, z) by `gap` all
 * round: one convex shape covers another when it reaches further in every
 * direction (its support function is larger). The shell must be at least
 * as tall as the head; it is never deeper than the head is tall.
 */
export function coveringDepth(
  head: readonly [number, number],
  height: number,
  tilt: number,
  gap: number,
): number {
  let depth = head[1] + gap;
  for (let step = 0; step < 180; step += 1) {
    const angle = (step / 180) * Math.PI;
    const [uy, uz] = [Math.cos(angle), Math.sin(angle)];
    const reach = Math.hypot(head[0] * uy, head[1] * uz) + gap;
    // The direction in the shell's own, tilted, axes.
    const along = uy * Math.cos(tilt) + uz * Math.sin(tilt);
    const across = -uy * Math.sin(tilt) + uz * Math.cos(tilt);
    if (across ** 2 > 1e-6) {
      const needed = (reach ** 2 - (height * along) ** 2) / across ** 2;
      depth = Math.max(depth, Math.sqrt(Math.max(needed, 0)));
    }
  }
  return Math.min(depth, Math.max(...head) + gap);
}

/** The head as the parts above it see it: its centre, radii and face's front. */
interface Head {
  readonly centre: Vec3;
  readonly radii: Vec3;
  /** How far the face's front is ahead of the centre, at eye height. */
  readonly front: number;
}

function headOf(avatar: Avatar, rig: Rig): Head {
  const face = faceShapes[avatar.face];
  const radii: Vec3 = [
    rig.head.radii[0] * face.radii[0],
    rig.head.radii[1] * face.radii[1],
    rig.head.radii[2] * face.radii[2],
  ];
  return { centre: rig.head.centre, radii, front: radii[2] * 0.97 };
}

/** The body: skin, and the outfit's colours on the parts it covers. */
function body(avatar: Avatar, rig: Rig, head: Head): Shape[] {
  const { joints, scale: s, build, limbRadii } = rig;
  const outfit = avatar.outfit.style;
  const top: Tint = outfit === "overalls" ? "secondary" : "primary";
  const legs: Tint =
    outfit === "dress" || outfit === "overalls" ? "primary" : "secondary";
  const longSleeves = ["hoodie", "shirt", "blazer", "sweater"].includes(outfit);
  const shins: Tint = outfit === "dress" ? "skin" : legs;
  const face = faceShapes[avatar.face];
  const [hx, hy, hz] = head.radii;
  const shapes: Shape[] = [
    {
      name: "pelvis",
      kind: "ellipsoid",
      bone: "hips",
      tint: legs,
      finish: "fabric",
      detail: "large",
      at: add(joints.hips, [0, -0.03 * s, 0]),
      radii: [0.15 * s * build.hips, 0.12 * s, 0.105 * s * build.depth],
    },
    // The torso is two capsules, flattened front to back, whose sides run
    // straight into each other rather than bulging like beads.
    {
      name: "waist",
      kind: "capsule",
      bone: "spine",
      tint: outfit === "overalls" ? "primary" : top,
      finish: "fabric",
      detail: "large",
      // Its round bottom tucked into the pelvis: the waistband shows.
      from: add(joints.hips, [0, 0.07 * s, 0]),
      to: add(joints.chest, [0, -0.02 * s, 0]),
      radii: [
        0.135 * s * build.hips,
        0.13 * s * Math.sqrt(build.hips * build.shoulders),
      ],
      flatten: 0.74 * build.depth,
    },
    {
      name: "chest",
      kind: "capsule",
      bone: "chest",
      tint: top,
      finish: "fabric",
      detail: "large",
      from: add(joints.chest, [0, 0.0, -0.005 * s]),
      // Its rounded top reaches the shoulders, under the neck.
      to: add(joints.chest, [0, 0.03 * s, -0.005 * s]),
      radii: [
        0.135 * s * Math.sqrt(build.hips * build.shoulders),
        0.15 * s * build.shoulders,
      ],
      flatten: 0.72 * build.depth,
    },
    {
      name: "neck",
      kind: "capsule",
      bone: "neck",
      tint: "skin",
      finish: "skin",
      detail: "small",
      from: add(joints.neck, [0, -0.04 * s, 0]),
      to: add(joints.head, [0, 0.04 * s, 0]),
      radii: [0.048 * s, 0.044 * s],
    },
    {
      name: "head",
      kind: "ellipsoid",
      bone: "head",
      tint: "skin",
      finish: "skin",
      detail: "large",
      at: head.centre,
      radii: head.radii,
    },
    {
      name: "jaw",
      kind: "ellipsoid",
      bone: "head",
      tint: "skin",
      finish: "skin",
      detail: "small",
      at: add(head.centre, [0, -hy * face.jaw.drop, hz * 0.1]),
      radii: [
        hx * face.jaw.radii[0],
        hy * face.jaw.radii[1],
        hz * face.jaw.radii[2],
      ],
    },
    {
      name: "nose",
      kind: "ellipsoid",
      bone: "head",
      tint: "skin",
      finish: "skin",
      detail: "tiny",
      at: add(head.centre, [0, -0.02 * s, head.front]),
      radii: scaled([0.014, 0.022, 0.02], s),
    },
  ];
  for (const { sign, side } of sides) {
    const bone = (part: LimbPart): BoneName => limbBones[side][part];
    const shoulder = joints[bone("UpperArm")];
    const elbow = joints[bone("Forearm")];
    const wrist = joints[bone("Hand")];
    const hip = joints[bone("Thigh")];
    const knee = joints[bone("Shin")];
    const ankle = joints[bone("Foot")];
    shapes.push(
      {
        name: `${side} ear`,
        kind: "ellipsoid",
        bone: "head",
        tint: "skin",
        finish: "skin",
        detail: "tiny",
        at: add(head.centre, [sign * hx * 0.98, -0.01 * s, -0.005 * s]),
        radii: scaled([0.016, 0.034, 0.026], s),
      },
      {
        name: `${side} eye`,
        kind: "ellipsoid",
        bone: "head",
        tint: "ink",
        finish: "plastic",
        detail: "tiny",
        at: add(head.centre, [sign * 0.038 * s, 0.012 * s, head.front * 0.93]),
        radii: scaled([0.013, 0.017, 0.01], s),
      },
      {
        name: `${side} brow`,
        kind: "capsule",
        bone: "head",
        tint:
          avatar.hairstyle === "bald"
            ? { mix: ["skin", "hair"], amount: 0.6 }
            : "hair",
        finish: "hair",
        detail: "tiny",
        from: add(head.centre, [sign * 0.02 * s, 0.045 * s, head.front * 0.9]),
        to: add(head.centre, [sign * 0.058 * s, 0.05 * s, head.front * 0.8]),
        radii: [0.006 * s, 0.005 * s],
      },
      {
        name: `${side} shoulder`,
        kind: "ellipsoid",
        bone: bone("Shoulder"),
        tint: top,
        finish: "fabric",
        detail: "small",
        at: add(shoulder, [-sign * 0.01 * s, 0.01 * s, 0]),
        radii: scaled([1.12, 1.05, 1.1], limbRadii.upperArm),
      },
      {
        name: `${side} upper arm`,
        kind: "capsule",
        bone: bone("UpperArm"),
        tint: top,
        finish: "fabric",
        detail: "large",
        from: shoulder,
        to: elbow,
        radii: [limbRadii.upperArm, limbRadii.upperArm * 0.88],
      },
      {
        name: `${side} forearm`,
        kind: "capsule",
        bone: bone("Forearm"),
        tint: longSleeves ? top : "skin",
        finish: longSleeves ? "fabric" : "skin",
        detail: "large",
        from: elbow,
        to: wrist,
        radii: [limbRadii.forearm, limbRadii.forearm * 0.82],
      },
      {
        name: `${side} hand`,
        kind: "ellipsoid",
        bone: bone("Hand"),
        tint: "skin",
        finish: "skin",
        detail: "small",
        at: add(wrist, [0, -0.045 * s, 0.004 * s]),
        radii: [0.022 * s * build.limbs, 0.05 * s, 0.04 * s * build.limbs],
      },
      {
        name: `${side} thigh`,
        kind: "capsule",
        bone: bone("Thigh"),
        tint: legs,
        finish: "fabric",
        detail: "large",
        from: hip,
        to: knee,
        radii: [limbRadii.thigh, limbRadii.thigh * 0.76],
      },
      {
        name: `${side} shin`,
        kind: "capsule",
        bone: bone("Shin"),
        tint: shins,
        finish: shins === "skin" ? "skin" : "fabric",
        detail: "large",
        from: knee,
        to: ankle,
        radii: [limbRadii.shin, limbRadii.shin * 0.72],
      },
      {
        name: `${side} shoe`,
        kind: "ellipsoid",
        bone: bone("Foot"),
        tint: shoes,
        finish: "plastic",
        detail: "small",
        // Its sole on the floor, its toe forwards.
        at: add(ankle, [0, -ankle[1] + 0.042 * s, 0.045 * s]),
        radii: scaled([0.045, 0.042, 0.11], s),
      },
    );
  }
  return shapes;
}

/** Shapes on both sides: `make` for the left, mirrored for the right. */
const bothSides = (make: (sign: 1 | -1) => Shape): Shape[] =>
  sides.map(({ sign }) => make(sign));

/** The outfit's own parts, over the body's tints: collars, hoods, a skirt. */
function outfitParts(avatar: Avatar, rig: Rig): Shape[] {
  const { joints, scale: s, build } = rig;
  const chestFront = 0.11 * s * build.depth;
  const neckBase = add(joints.neck, [0, -0.03 * s, 0]);
  const collar = (tint: Tint, tube = 0.016): Shape => ({
    name: "collar",
    kind: "torus",
    bone: "chest",
    tint,
    finish: "fabric",
    detail: "small",
    at: neckBase,
    rotation: [Math.PI / 2 - 0.25, 0, 0],
    radius: 0.06 * s,
    tube: tube * s,
  });
  const cuffs = (tint: Tint): Shape[] =>
    sides.map(({ sign, side }) => ({
      name: `${side} cuff`,
      kind: "torus",
      bone: sign === 1 ? "leftForearm" : "rightForearm",
      tint,
      finish: "fabric",
      detail: "tiny",
      at: add(joints[sign === 1 ? "leftHand" : "rightHand"], [0, 0.025 * s, 0]),
      rotation: [Math.PI / 2, 0, 0],
      radius: rig.limbRadii.forearm * 0.85,
      tube: 0.012 * s,
    }));
  switch (avatar.outfit.style) {
    case "t-shirt":
      return [collar("secondary", 0.01)];
    case "shirt":
      return [
        ...bothSides((sign) => ({
          name: `${sign === 1 ? "left" : "right"} collar point`,
          kind: "box",
          bone: "chest",
          tint: "secondary",
          finish: "fabric",
          detail: "tiny",
          at: add(neckBase, [sign * 0.035 * s, -0.025 * s, 0.055 * s]),
          rotation: [-0.3, 0, sign * 0.6],
          size: scaled([0.05, 0.035, 0.01], s),
        })),
        {
          name: "button placket",
          kind: "box",
          bone: "chest",
          tint: "secondary",
          finish: "fabric",
          detail: "tiny",
          at: add(joints.chest, [0, 0.02 * s, chestFront * 0.97]),
          rotation: [0.2, 0, 0],
          size: scaled([0.018, 0.2, 0.01], s),
        },
      ];
    case "blazer":
      return [
        {
          name: "shirt",
          kind: "box",
          bone: "chest",
          tint: "paper",
          finish: "fabric",
          detail: "tiny",
          at: add(joints.chest, [0, 0.08 * s, chestFront * 0.96]),
          rotation: [0.25, 0, 0],
          size: scaled([0.07, 0.14, 0.012], s),
        },
        ...bothSides((sign) => ({
          name: `${sign === 1 ? "left" : "right"} lapel`,
          kind: "box",
          bone: "chest",
          tint: "primary",
          finish: "fabric",
          detail: "tiny",
          at: add(joints.chest, [sign * 0.045 * s, 0.07 * s, chestFront * 1.0]),
          rotation: [0.25, 0, sign * 0.35],
          size: scaled([0.035, 0.17, 0.014], s),
        })),
        ...cuffs("secondary"),
      ];
    case "hoodie":
      return [
        {
          name: "hood",
          kind: "torus",
          bone: "chest",
          tint: "primary",
          finish: "fabric",
          detail: "small",
          at: add(neckBase, [0, 0.0, -0.03 * s]),
          rotation: [Math.PI / 2 - 0.6, 0, 0],
          radius: 0.075 * s,
          tube: 0.035 * s,
        },
        ...bothSides((sign) => ({
          name: `${sign === 1 ? "left" : "right"} drawstring`,
          kind: "capsule",
          bone: "chest",
          tint: "secondary",
          finish: "fabric",
          detail: "tiny",
          from: add(neckBase, [sign * 0.025 * s, -0.02 * s, 0.07 * s]),
          to: add(neckBase, [sign * 0.028 * s, -0.12 * s, 0.1 * s]),
          radii: [0.005 * s, 0.005 * s],
        })),
        {
          name: "pocket",
          kind: "box",
          bone: "spine",
          tint: "primary",
          finish: "fabric",
          detail: "tiny",
          at: add(joints.spine, [0, 0.0, 0.098 * s * build.depth]),
          size: scaled([0.17, 0.08, 0.02], s),
        },
        ...cuffs("secondary"),
      ];
    case "sweater":
      return [collar("secondary", 0.02), ...cuffs("secondary")];
    case "dress": {
      const waist = add(joints.hips, [0, 0.07 * s, 0]);
      return [
        {
          name: "skirt",
          kind: "frustum",
          bone: "hips",
          skirt: true,
          tint: "primary",
          finish: "fabric",
          detail: "large",
          from: waist,
          to: add(joints.hips, [0, -0.4 * s, 0.01 * s]),
          radii: [0.14 * s * build.hips, 0.25 * s * build.hips],
          flatten: 0.8,
        },
        {
          name: "belt",
          kind: "torus",
          bone: "spine",
          tint: "secondary",
          finish: "fabric",
          detail: "small",
          at: add(waist, [0, 0.02 * s, 0]),
          rotation: [Math.PI / 2, 0, 0],
          radius: 0.13 * s * build.hips,
          tube: 0.016 * s,
          scale: [1, 0.78 * build.depth, 1],
        },
      ];
    }
    case "overalls":
      return [
        {
          name: "bib",
          kind: "box",
          bone: "chest",
          tint: "primary",
          finish: "fabric",
          detail: "tiny",
          at: add(joints.chest, [0, 0.0, chestFront * 0.88]),
          rotation: [0.12, 0, 0],
          size: scaled([0.19, 0.17, 0.016], s),
        },
        ...bothSides((sign) => ({
          name: `${sign === 1 ? "left" : "right"} strap`,
          kind: "capsule",
          bone: "chest",
          tint: "primary",
          finish: "fabric",
          detail: "tiny",
          from: add(joints.chest, [sign * 0.08 * s, 0.09 * s, chestFront]),
          to: add(joints.chest, [sign * 0.08 * s, 0.15 * s, -chestFront * 0.9]),
          radii: [0.012 * s, 0.012 * s],
          flatten: 0.5,
        })),
      ];
  }
}

/** The hair: a cap over the crown, and the style's masses. */
function hair(avatar: Avatar, rig: Rig, head: Head): Shape[] {
  const s = rig.scale;
  const [hx, hy, hz] = head.radii;
  const c = head.centre;
  const shell = (
    name: string,
    grow: number,
    cut: number,
    tilt: number,
    lift = 0,
    // Deep enough to cover the head, tilted, but no deeper.
    radii: Vec3 = [
      hx + grow * s,
      hy + grow * s,
      coveringDepth([hy, hz], hy + grow * s, tilt, grow * s),
    ],
  ): Shape => ({
    name,
    kind: "dome",
    bone: "head",
    tint: "hair",
    finish: "hair",
    detail: "large",
    at: add(c, [0, lift * s, -0.004 * s]),
    rotation: [tilt, 0, 0],
    radii,
    cut,
  });
  const mass = (
    name: string,
    at: Vec3,
    radii: Vec3,
    detail: ShapeDetail = "small",
  ): Shape => ({
    name,
    kind: "ellipsoid",
    bone: "head",
    tint: "hair",
    finish: "hair",
    detail,
    at: add(c, scaled(at, s)),
    radii: scaled(radii, s),
  });
  const cap = shell("hair", 0.012, 0.5, -0.45);
  switch (avatar.hairstyle) {
    case "bald":
      return [];
    case "crop":
      return [shell("hair", 0.006, 0.47, -0.5)];
    case "short":
      return [cap];
    case "bob":
      return [
        cap,
        ...bothSides((sign) =>
          mass(
            `${sign === 1 ? "left" : "right"} side`,
            [sign * 0.085, -0.035, -0.02],
            [0.04, 0.1, 0.09],
          ),
        ),
        mass("back", [0, -0.03, -0.07], [0.1, 0.1, 0.06]),
      ];
    case "long":
      return [
        cap,
        ...bothSides((sign) =>
          mass(
            `${sign === 1 ? "left" : "right"} side`,
            [sign * 0.088, -0.06, -0.025],
            [0.035, 0.13, 0.08],
          ),
        ),
        mass("back", [0, -0.12, -0.075], [0.1, 0.2, 0.055], "large"),
      ];
    case "curly":
      return [
        shell("hair", 0.02, 0.5, -0.45),
        ...Array.from({ length: 8 }, (_, index) => {
          const angle = (index / 8) * Math.PI * 2;
          return mass(
            `curl ${String(index + 1)}`,
            [
              Math.sin(angle) * 0.1,
              0.07 + 0.03 * Math.cos(angle * 2),
              Math.cos(angle) * 0.1 - 0.02,
            ],
            [0.042, 0.042, 0.042],
            "tiny",
          );
        }),
      ];
    case "ponytail":
      return [
        cap,
        {
          name: "ponytail",
          kind: "capsule",
          bone: "head",
          tint: "hair",
          finish: "hair",
          detail: "small",
          from: add(c, [0, 0.03 * s, -hz - 0.02 * s]),
          to: add(c, [0, -0.17 * s, -hz - 0.07 * s]),
          radii: [0.038 * s, 0.018 * s],
        },
      ];
    case "bun":
      return [
        cap,
        mass("bun", [0, hy / s + 0.01, -0.06], [0.058, 0.05, 0.058]),
      ];
    case "afro":
      return [
        shell("hair", 0, 0.56, -0.45, 0.025, [hx * 1.5, hy * 1.32, hz * 1.4]),
      ];
    case "braids":
      return [
        cap,
        ...bothSides((sign) => ({
          name: `${sign === 1 ? "left" : "right"} braid`,
          kind: "capsule",
          bone: "head",
          tint: "hair",
          finish: "hair",
          detail: "small",
          from: add(c, [sign * 0.06 * s, -0.01 * s, -hz * 0.75]),
          to: add(c, [sign * 0.075 * s, -0.27 * s, -hz * 0.75]),
          radii: [0.024 * s, 0.016 * s],
        })),
      ];
  }
}

/** The hair's outer radii about the head's centre, for a cap or headphones over it. */
function hairRadii(avatar: Avatar, rig: Rig, head: Head): Vec3 {
  if (avatar.hairstyle === "afro") {
    return [head.radii[0] * 1.5, head.radii[1] * 1.32, head.radii[2] * 1.4];
  }
  const grow =
    avatar.hairstyle === "bald"
      ? 0.002
      : avatar.hairstyle === "crop"
        ? 0.008
        : avatar.hairstyle === "curly"
          ? 0.05
          : 0.016;
  return [
    head.radii[0] + grow * rig.scale,
    head.radii[1] + grow * rig.scale,
    head.radii[2] + grow * rig.scale,
  ];
}

function facialHair(avatar: Avatar, rig: Rig, head: Head): Shape[] {
  const s = rig.scale;
  const [hx, hy, hz] = head.radii;
  const c = head.centre;
  const moustache: Shape = {
    name: "moustache",
    kind: "capsule",
    bone: "head",
    tint: "hair",
    finish: "hair",
    detail: "tiny",
    from: add(c, [-0.03 * s, -0.045 * s, head.front * 0.9]),
    to: add(c, [0.03 * s, -0.045 * s, head.front * 0.9]),
    radii: [0.011 * s, 0.011 * s],
  };
  const lowerFace = (
    name: string,
    tint: Tint,
    grow: number,
    cut: number,
  ): Shape => ({
    name,
    kind: "dome",
    bone: "head",
    tint,
    finish: "hair",
    detail: "small",
    // Upside down and tipped forwards: over the jaw and chin, open
    // above, its front edge under the nose.
    at: add(c, [0, -hy * 0.32, hz * 0.06]),
    rotation: [Math.PI - 0.35, 0, 0],
    radii: [hx * 0.9 + grow * s, hy * 0.66 + grow * s, hz * 0.95 + grow * s],
    cut,
  });
  switch (avatar.facialHair) {
    case "none":
      return [];
    case "stubble":
      return [
        lowerFace(
          "stubble",
          { mix: ["skin", "hair"], amount: 0.45 },
          0.004,
          0.36,
        ),
      ];
    case "moustache":
      return [moustache];
    case "beard":
      return [lowerFace("beard", "hair", 0.016, 0.4), moustache];
    case "goatee":
      return [
        {
          name: "goatee",
          kind: "ellipsoid",
          bone: "head",
          tint: "hair",
          finish: "hair",
          detail: "tiny",
          at: add(c, [0, -hy * 0.8, hz * 0.62]),
          radii: scaled([0.026, 0.032, 0.02], s),
        },
        moustache,
      ];
  }
}

function glasses(avatar: Avatar, rig: Rig, head: Head): Shape[] {
  if (avatar.glasses === "none") {
    return [];
  }
  const s = rig.scale;
  const c = head.centre;
  const z = head.front + 0.012 * s;
  const y = 0.012 * s;
  const frame = {
    bone: "head",
    tint: "ink",
    finish: "plastic",
    detail: "tiny",
  } as const;
  const rim = (sign: 1 | -1): Shape => {
    const at = add(c, [sign * 0.04 * s, y, z]);
    const name = `${sign === 1 ? "left" : "right"} rim`;
    switch (avatar.glasses) {
      case "square":
        return {
          ...frame,
          name,
          kind: "torus",
          at,
          rotation: [0, 0, Math.PI / 4],
          radius: 0.028 * s,
          tube: 0.004 * s,
          sides: 4,
          scale: [1.2, 0.85, 1],
        };
      case "cat-eye":
        return {
          ...frame,
          name,
          kind: "torus",
          at,
          rotation: [0, 0, sign * 0.3],
          radius: 0.024 * s,
          tube: 0.005 * s,
          sides: 6,
          scale: [1.25, 0.8, 1],
        };
      default:
        return {
          ...frame,
          name,
          kind: "torus",
          at,
          radius: 0.022 * s,
          tube: 0.004 * s,
        };
    }
  };
  return [
    ...bothSides(rim),
    {
      ...frame,
      name: "bridge",
      kind: "capsule",
      from: add(c, [-0.015 * s, y + 0.004 * s, z + 0.002 * s]),
      to: add(c, [0.015 * s, y + 0.004 * s, z + 0.002 * s]),
      radii: [0.0035 * s, 0.0035 * s],
    },
    ...bothSides((sign) => ({
      ...frame,
      name: `${sign === 1 ? "left" : "right"} temple`,
      kind: "capsule",
      from: add(c, [sign * 0.068 * s, y + 0.004 * s, z - 0.01 * s]),
      to: add(c, [sign * head.radii[0] * 1.01, y, -0.01 * s]),
      radii: [0.003 * s, 0.003 * s],
    })),
  ];
}

function accessory(
  kind: Avatar["accessories"][number],
  avatar: Avatar,
  rig: Rig,
  head: Head,
): Shape[] {
  const s = rig.scale;
  const c = head.centre;
  const over = hairRadii(avatar, rig, head);
  switch (kind) {
    case "headphones":
      return [
        {
          name: "headphone band",
          kind: "torus",
          bone: "head",
          tint: "ink",
          finish: "plastic",
          detail: "small",
          at: c,
          radius: over[0] + 0.015 * s,
          tube: 0.011 * s,
          arc: 0.5,
          scale: [1, (over[1] + 0.012 * s) / (over[0] + 0.015 * s), 1],
        },
        ...bothSides((sign) => ({
          name: `${sign === 1 ? "left" : "right"} ear cup`,
          kind: "frustum",
          bone: "head",
          tint: "secondary",
          finish: "plastic",
          detail: "small",
          from: add(c, [sign * (over[0] - 0.005 * s), -0.01 * s, 0]),
          to: add(c, [sign * (over[0] + 0.03 * s), -0.01 * s, 0]),
          radii: [0.04 * s, 0.036 * s],
        })),
      ];
    case "earrings":
      return bothSides((sign) => ({
        name: `${sign === 1 ? "left" : "right"} earring`,
        kind: "ellipsoid",
        bone: "head",
        tint: gold,
        finish: "metal",
        detail: "tiny",
        at: add(c, [sign * head.radii[0] * 1.02, -0.05 * s, 0]),
        radii: scaled([0.009, 0.009, 0.009], s),
      }));
    case "watch": {
      const wrist = add(rig.joints.leftHand, [0, 0.03 * s, 0]);
      return [
        {
          name: "watch strap",
          kind: "torus",
          bone: "leftForearm",
          tint: "ink",
          finish: "plastic",
          detail: "tiny",
          at: wrist,
          rotation: [Math.PI / 2, 0, 0],
          radius: rig.limbRadii.forearm * 0.86,
          tube: 0.008 * s,
        },
        {
          name: "watch face",
          kind: "frustum",
          bone: "leftForearm",
          tint: "metal-light",
          finish: "metal",
          detail: "tiny",
          from: add(wrist, [rig.limbRadii.forearm * 0.8, 0, 0]),
          to: add(wrist, [rig.limbRadii.forearm * 0.8 + 0.012 * s, 0, 0]),
          radii: [0.017 * s, 0.017 * s],
        },
      ];
    }
    case "scarf": {
      const neckBase = add(rig.joints.neck, [0, -0.01 * s, 0]);
      return [
        {
          name: "scarf",
          kind: "torus",
          bone: "chest",
          tint: "secondary",
          finish: "fabric",
          detail: "small",
          at: neckBase,
          rotation: [Math.PI / 2 - 0.2, 0, 0],
          radius: 0.065 * s,
          tube: 0.03 * s,
        },
        {
          name: "scarf end",
          kind: "capsule",
          bone: "chest",
          tint: "secondary",
          finish: "fabric",
          detail: "tiny",
          from: add(neckBase, [0.045 * s, -0.02 * s, 0.08 * s]),
          to: add(neckBase, [0.06 * s, -0.24 * s, 0.13 * s * rig.build.depth]),
          radii: [0.03 * s, 0.026 * s],
          flatten: 0.4,
        },
      ];
    }
    case "cap":
      return [
        {
          name: "cap",
          kind: "dome",
          bone: "head",
          tint: "secondary",
          finish: "fabric",
          detail: "small",
          at: add(c, [0, 0.01 * s, 0]),
          rotation: [-0.15, 0, 0],
          radii: [
            over[0] + 0.008 * s,
            over[1] + 0.006 * s,
            over[2] + 0.008 * s,
          ],
          cut: 0.4,
        },
        {
          name: "cap peak",
          kind: "ellipsoid",
          bone: "head",
          tint: "secondary",
          finish: "fabric",
          detail: "small",
          at: add(c, [0, over[1] * 0.38, over[2] * 0.95]),
          rotation: [0.2, 0, 0],
          radii: [over[0] * 0.8, 0.008 * s, 0.065 * s],
        },
      ];
  }
}

/**
 * Where a hat sits on an Avatar: its head's centre, the radii over its
 * hair, and its scale; for seasonal hats, costumes and the actors'.
 */
export interface HatFrame {
  readonly centre: Vec3;
  readonly over: Vec3;
  readonly scale: number;
}

export function hatFrame(avatar: Avatar, rig: Rig): HatFrame {
  const head = headOf(avatar, rig);
  return {
    centre: head.centre,
    over: hairRadii(avatar, rig, head),
    scale: rig.scale,
  };
}

/**
 * A change to an Avatar's shapes at render time, never saved: a seasonal
 * costume or hat, or an actor's dress. It may add shapes and drop some.
 */
export type Dress = (
  shapes: readonly AvatarShape[],
  avatar: Avatar,
  rig: Rig,
) => AvatarShape[];

/** Every shape of an Avatar, on its rig. */
export function avatarShapes(
  avatar: Avatar,
  rig: Rig = avatarRig(avatar),
): AvatarShape[] {
  const head = headOf(avatar, rig);
  return [
    ...body(avatar, rig, head),
    ...outfitParts(avatar, rig),
    ...hair(avatar, rig, head),
    ...facialHair(avatar, rig, head),
    ...glasses(avatar, rig, head),
    ...avatar.accessories.flatMap((kind) => accessory(kind, avatar, rig, head)),
  ];
}

/** A mascot's shapes, standing on the desk at the origin, facing +z. */
type MascotShape = UnboundShape;

/** A mascot's shape as written: plastic and tiny unless it says otherwise. */
type MascotInput = UnboundShape extends infer Each
  ? Each extends UnboundShape
    ? Omit<Each, "finish" | "detail"> & { readonly finish?: AvatarFinish }
    : never
  : never;

const mascotShape = (shape: MascotInput): MascotShape =>
  ({ finish: "plastic", detail: "tiny", ...shape }) as unknown as MascotShape;

/**
 * The desk mascots (FR-13): a small figure on the Agent's desk, its body
 * in the Avatar's secondary colour, 8 to 12 cm tall.
 */
export function mascotShapes(mascot: Avatar["deskMascot"]): MascotShape[] {
  const eyes = (y: number, z: number, apart: number): MascotShape[] =>
    [1, -1].map((sign) =>
      mascotShape({
        name: `${sign === 1 ? "left" : "right"} eye`,
        kind: "ellipsoid",
        tint: "ink",
        at: [sign * apart, y, z],
        radii: [0.005, 0.006, 0.004],
      }),
    );
  const pot = (top: number): MascotShape =>
    mascotShape({
      name: "pot",
      kind: "frustum",
      tint: "secondary",
      from: [0, 0, 0],
      to: [0, top, 0],
      radii: [0.026, 0.034],
    });
  switch (mascot) {
    case "cactus":
      return [
        pot(0.04),
        mascotShape({
          name: "stem",
          kind: "capsule",
          tint: "plant",
          from: [0, 0.05, 0],
          to: [0, 0.1, 0],
          radii: [0.022, 0.02],
        }),
        mascotShape({
          name: "arm",
          kind: "capsule",
          tint: "plant",
          from: [0.02, 0.07, 0],
          to: [0.038, 0.095, 0],
          radii: [0.009, 0.008],
        }),
      ];
    case "rubber-duck":
      return [
        mascotShape({
          name: "body",
          kind: "ellipsoid",
          tint: "secondary",
          at: [0, 0.025, 0],
          radii: [0.035, 0.025, 0.045],
        }),
        mascotShape({
          name: "head",
          kind: "ellipsoid",
          tint: "secondary",
          at: [0, 0.062, 0.02],
          radii: [0.022, 0.022, 0.022],
        }),
        mascotShape({
          name: "beak",
          kind: "ellipsoid",
          tint: { swatch: "#e07a5f" },
          at: [0, 0.058, 0.044],
          radii: [0.012, 0.005, 0.01],
        }),
        ...eyes(0.068, 0.038, 0.01),
      ];
    case "robot":
      return [
        mascotShape({
          name: "body",
          kind: "box",
          tint: "secondary",
          at: [0, 0.03, 0],
          size: [0.05, 0.05, 0.035],
        }),
        mascotShape({
          name: "head",
          kind: "box",
          tint: "metal-light",
          finish: "metal",
          at: [0, 0.075, 0],
          size: [0.04, 0.035, 0.035],
        }),
        ...eyes(0.078, 0.018, 0.01),
        mascotShape({
          name: "antenna",
          kind: "capsule",
          tint: "ink",
          from: [0, 0.095, 0],
          to: [0, 0.11, 0],
          radii: [0.003, 0.006],
        }),
      ];
    case "cat":
      return [
        mascotShape({
          name: "body",
          kind: "ellipsoid",
          tint: "secondary",
          at: [0, 0.03, -0.005],
          radii: [0.028, 0.03, 0.035],
        }),
        mascotShape({
          name: "head",
          kind: "ellipsoid",
          tint: "secondary",
          at: [0, 0.07, 0.015],
          radii: [0.024, 0.021, 0.021],
        }),
        ...[1, -1].map((sign) =>
          mascotShape({
            name: `${sign === 1 ? "left" : "right"} ear`,
            kind: "frustum",
            tint: "secondary",
            from: [sign * 0.013, 0.083, 0.015],
            to: [sign * 0.017, 0.1, 0.015],
            radii: [0.008, 0.001],
          }),
        ),
        ...eyes(0.072, 0.034, 0.009),
        mascotShape({
          name: "tail",
          kind: "capsule",
          tint: "secondary",
          from: [0.01, 0.015, -0.035],
          to: [0.03, 0.06, -0.05],
          radii: [0.006, 0.005],
        }),
      ];
    case "bonsai":
      return [
        mascotShape({
          name: "pot",
          kind: "box",
          tint: "secondary",
          at: [0, 0.012, 0],
          size: [0.08, 0.024, 0.05],
        }),
        mascotShape({
          name: "trunk",
          kind: "capsule",
          tint: "floor-wood",
          finish: "fabric",
          from: [0, 0.024, 0],
          to: [0.015, 0.07, 0],
          radii: [0.008, 0.005],
        }),
        ...(
          [
            [-0.012, 0.075, 0, 0.026],
            [0.025, 0.08, 0.005, 0.02],
            [0.005, 0.095, -0.008, 0.018],
          ] as const
        ).map(([x, y, z, r], index) =>
          mascotShape({
            name: `leaves ${String(index + 1)}`,
            kind: "ellipsoid",
            tint: "plant",
            at: [x, y, z],
            radii: [r, r * 0.7, r],
          }),
        ),
      ];
    case "dinosaur":
      return [
        mascotShape({
          name: "body",
          kind: "ellipsoid",
          tint: "secondary",
          at: [0, 0.035, 0],
          radii: [0.025, 0.025, 0.04],
        }),
        mascotShape({
          name: "neck",
          kind: "capsule",
          tint: "secondary",
          from: [0, 0.045, 0.025],
          to: [0, 0.08, 0.04],
          radii: [0.014, 0.012],
        }),
        mascotShape({
          name: "head",
          kind: "ellipsoid",
          tint: "secondary",
          at: [0, 0.088, 0.05],
          radii: [0.015, 0.013, 0.022],
        }),
        mascotShape({
          name: "tail",
          kind: "capsule",
          tint: "secondary",
          from: [0, 0.035, -0.035],
          to: [0, 0.015, -0.075],
          radii: [0.013, 0.004],
        }),
        ...[
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ].map(([side = 1, end = 1]) =>
          mascotShape({
            name: "leg",
            kind: "capsule",
            tint: "secondary",
            from: [side * 0.016, 0.02, end * 0.02],
            to: [side * 0.017, 0.005, end * 0.02],
            radii: [0.007, 0.006],
          }),
        ),
        ...eyes(0.094, 0.064, 0.008),
      ];
  }
}

/** A pen's or pencil's ink, a sticky note's yellow and an apple's red. */
const deskSwatches = {
  ink: { swatch: "#1f3a5f" },
  yellow: { swatch: "#ffe066" },
  wood: { swatch: "#d9b26f" },
  red: { swatch: "#c0392b" },
  pink: { swatch: "#f4a6b7" },
  blue: { swatch: "#3f88c5" },
  gold: { swatch: "#d98e04" },
  white: { swatch: "#f7f5f0" },
} as const satisfies Record<string, Tint>;

/**
 * A desk item's shapes (FR-13): lying or standing on the desk at the
 * origin, facing +z, the Agent's side. Each fits in a 10 cm square, so it
 * sits in its slot clear of the desk's dressing; some take the Avatar's
 * secondary colour.
 */
export function deskItemShapes(item: DeskItemKind): MascotShape[] {
  const slab = (
    name: string,
    tint: Tint,
    size: Vec3,
    at: Vec3 = [0, size[1] / 2, 0],
    rotation?: Vec3,
  ): MascotShape =>
    mascotShape({
      name,
      kind: "box",
      tint,
      size,
      at,
      ...(rotation === undefined ? {} : { rotation }),
    });
  const stick = (
    name: string,
    tint: Tint,
    from: Vec3,
    to: Vec3,
    radius: number,
  ): MascotShape =>
    mascotShape({
      name,
      kind: "capsule",
      tint,
      from,
      to,
      radii: [radius, radius],
    });
  const drum = (
    name: string,
    tint: Tint,
    from: Vec3,
    to: Vec3,
    radii: readonly [number, number],
  ): MascotShape =>
    mascotShape({ name, kind: "frustum", tint, from, to, radii });
  switch (item) {
    case "laptop":
      return [
        slab("base", "metal-light", [0.1, 0.006, 0.07]),
        slab("keys", "metal-dark", [0.085, 0.001, 0.035], [0, 0.0065, 0.01]),
        slab(
          "lid",
          "metal-light",
          [0.1, 0.065, 0.004],
          [0, 0.036, -0.04],
          [-0.25, 0, 0],
        ),
        slab(
          "screen",
          "screen-glow",
          [0.088, 0.054, 0.001],
          [0, 0.036, -0.037],
          [-0.25, 0, 0],
        ),
      ];
    case "pen":
      return [
        stick(
          "barrel",
          deskSwatches.ink,
          [-0.045, 0.005, 0],
          [0.04, 0.005, 0.01],
          0.004,
        ),
        stick(
          "clip",
          "metal-light",
          [-0.04, 0.009, 0],
          [-0.02, 0.009, 0.003],
          0.0015,
        ),
      ];
    case "pencil":
      return [
        stick(
          "body",
          deskSwatches.yellow,
          [-0.04, 0.004, -0.01],
          [0.035, 0.004, 0.01],
          0.004,
        ),
        drum(
          "tip",
          deskSwatches.wood,
          [0.035, 0.004, 0.01],
          [0.047, 0.004, 0.013],
          [0.004, 0.001],
        ),
        stick(
          "rubber",
          deskSwatches.pink,
          [-0.047, 0.004, -0.012],
          [-0.04, 0.004, -0.01],
          0.004,
        ),
      ];
    case "paper":
      return [
        slab("sheet", "paper", [0.07, 0.002, 0.1], undefined, [0, 0.15, 0]),
        slab(
          "sheet under",
          "paper",
          [0.07, 0.002, 0.1],
          [0.004, 0.003, 0.002],
          [0, -0.1, 0],
        ),
      ];
    case "ruler":
      return [
        slab(
          "ruler",
          deskSwatches.wood,
          [0.1, 0.003, 0.022],
          undefined,
          [0, 0.3, 0],
        ),
        slab("marks", "ink", [0.09, 0.001, 0.004], [0, 0.0035, 0], [0, 0.3, 0]),
      ];
    case "notebook":
      return [
        slab("pages", "paper", [0.066, 0.012, 0.092]),
        slab("cover", "secondary", [0.07, 0.003, 0.095], [0, 0.0135, 0]),
        slab("band", "ink", [0.004, 0.0035, 0.095], [0.025, 0.0137, 0]),
      ];
    case "coffee-mug":
      return [
        drum("mug", "secondary", [0, 0, 0], [0, 0.075, 0], [0.026, 0.028]),
        drum(
          "coffee",
          { swatch: "#4a3021" },
          [0, 0.07, 0],
          [0, 0.0705, 0],
          [0.025, 0.025],
        ),
        mascotShape({
          name: "handle",
          kind: "torus",
          tint: "secondary",
          at: [0.03, 0.04, 0],
          radius: 0.016,
          tube: 0.004,
        }),
      ];
    case "stapler":
      return [
        slab("base", "ink", [0.028, 0.008, 0.09]),
        slab(
          "arm",
          "secondary",
          [0.026, 0.014, 0.085],
          [0, 0.017, -0.002],
          [0.05, 0, 0],
        ),
      ];
    case "desk-lamp":
      return [
        drum("base", "metal-dark", [0, 0, 0], [0, 0.01, 0], [0.035, 0.035]),
        stick(
          "lower arm",
          "metal-dark",
          [0, 0.01, -0.01],
          [0, 0.1, -0.03],
          0.004,
        ),
        stick(
          "upper arm",
          "metal-dark",
          [0, 0.1, -0.03],
          [0, 0.14, 0.02],
          0.004,
        ),
        drum(
          "shade",
          "secondary",
          [0, 0.15, 0.02],
          [0, 0.12, 0.04],
          [0.012, 0.03],
        ),
        mascotShape({
          name: "bulb",
          kind: "ellipsoid",
          tint: "lamp",
          at: [0, 0.122, 0.04],
          radii: [0.012, 0.006, 0.012],
        }),
      ];
    case "potted-plant":
      return [
        drum("pot", "ceramic", [0, 0, 0], [0, 0.06, 0], [0.03, 0.038]),
        mascotShape({
          name: "leaves",
          kind: "ellipsoid",
          tint: "plant",
          at: [0, 0.1, 0],
          radii: [0.045, 0.05, 0.045],
        }),
      ];
    case "sticky-notes":
      return [
        slab("pad", deskSwatches.yellow, [0.05, 0.012, 0.05]),
        slab(
          "loose note",
          deskSwatches.yellow,
          [0.05, 0.001, 0.05],
          [0.02, 0.0125, 0.01],
          [0, 0.4, 0],
        ),
      ];
    case "calculator":
      return [
        slab("body", "metal-dark", [0.06, 0.01, 0.09]),
        slab(
          "display",
          "screen-glow",
          [0.048, 0.001, 0.018],
          [0, 0.0105, -0.03],
        ),
        slab("keys", "paper", [0.048, 0.002, 0.05], [0, 0.011, 0.012]),
      ];
    case "scissors":
      return [
        stick(
          "blade",
          "metal-light",
          [-0.01, 0.004, 0.015],
          [0.03, 0.004, -0.04],
          0.0035,
        ),
        stick(
          "other blade",
          "metal-light",
          [0.01, 0.004, 0.015],
          [-0.03, 0.004, -0.04],
          0.0035,
        ),
        ...[-1, 1].map((side) =>
          mascotShape({
            name: side === 1 ? "right handle" : "left handle",
            kind: "torus",
            tint: "secondary",
            at: [side * 0.016, 0.004, 0.03],
            rotation: [Math.PI / 2, 0, 0],
            radius: 0.013,
            tube: 0.0035,
          }),
        ),
      ];
    case "tape-dispenser":
      return [
        slab("base", "ink", [0.04, 0.03, 0.09]),
        mascotShape({
          name: "tape",
          kind: "torus",
          tint: "glass",
          at: [0, 0.05, -0.01],
          rotation: [0, Math.PI / 2, 0],
          radius: 0.022,
          tube: 0.008,
        }),
      ];
    case "paper-clips":
      return [
        drum("dish", "metal-dark", [0, 0, 0], [0, 0.012, 0], [0.035, 0.04]),
        ...[0, 1, 2].map((index) =>
          mascotShape({
            name: `clip ${String(index + 1)}`,
            kind: "torus",
            tint: "metal-light",
            at: [(index - 1) * 0.015, 0.014, (index % 2) * 0.01 - 0.005],
            rotation: [Math.PI / 2, 0, index],
            radius: 0.008,
            tube: 0.0012,
            sides: 4,
            scale: [1, 1.8, 1],
          }),
        ),
      ];
    case "pen-pot":
      return [
        drum("pot", "secondary", [0, 0, 0], [0, 0.09, 0], [0.03, 0.03]),
        stick(
          "pen",
          deskSwatches.ink,
          [0.008, 0.05, 0],
          [0.018, 0.13, 0.008],
          0.004,
        ),
        stick(
          "pencil",
          deskSwatches.yellow,
          [-0.008, 0.05, 0.005],
          [-0.02, 0.135, 0.012],
          0.004,
        ),
        stick(
          "highlighter",
          "state-ok",
          [0, 0.05, -0.008],
          [-0.004, 0.12, -0.02],
          0.006,
        ),
      ];
    case "headphones":
      return [
        mascotShape({
          name: "band",
          kind: "torus",
          tint: "metal-dark",
          at: [0, 0.006, 0],
          rotation: [Math.PI / 2, 0, 0],
          radius: 0.04,
          tube: 0.004,
          arc: 0.5,
        }),
        ...[-1, 1].map((side) =>
          mascotShape({
            name: side === 1 ? "right cup" : "left cup",
            kind: "ellipsoid",
            tint: "secondary",
            at: [side * 0.04, 0.012, 0.01],
            radii: [0.014, 0.012, 0.02],
          }),
        ),
      ];
    case "phone":
      return [
        slab("phone", "ink", [0.04, 0.008, 0.08], undefined, [0, -0.2, 0]),
        slab(
          "screen",
          "screen-glow",
          [0.035, 0.001, 0.07],
          [0, 0.0085, 0],
          [0, -0.2, 0],
        ),
      ];
    case "tablet":
      return [
        slab("tablet", "ink", [0.075, 0.007, 0.1]),
        slab("screen", "screen-glow", [0.066, 0.001, 0.088], [0, 0.0075, 0]),
      ];
    case "water-bottle":
      return [
        stick("bottle", deskSwatches.blue, [0, 0.022, 0], [0, 0.13, 0], 0.022),
        drum("cap", "metal-dark", [0, 0.14, 0], [0, 0.165, 0], [0.014, 0.014]),
      ];
    case "book-stack":
      return [
        slab("bottom book", "stage-work", [0.07, 0.018, 0.095]),
        slab(
          "middle book",
          "secondary",
          [0.066, 0.016, 0.09],
          [0.003, 0.026, 0],
          [0, 0.15, 0],
        ),
        slab(
          "top book",
          "stage-docs",
          [0.06, 0.014, 0.085],
          [-0.002, 0.041, 0.002],
          [0, -0.12, 0],
        ),
      ];
    case "desk-clock":
      return [
        drum(
          "case",
          "secondary",
          [0, 0.04, -0.008],
          [0, 0.04, 0.008],
          [0.036, 0.036],
        ),
        drum("face", "paper", [0, 0.04, 0.008], [0, 0.04, 0.009], [0.03, 0.03]),
        slab("hour hand", "ink", [0.003, 0.016, 0.001], [0, 0.047, 0.0095]),
        slab("minute hand", "ink", [0.022, 0.003, 0.001], [0.01, 0.04, 0.0095]),
        slab("foot", "secondary", [0.03, 0.006, 0.02], [0, 0.003, 0]),
      ];
    case "photo-frame":
      return [
        slab(
          "frame",
          "metal-dark",
          [0.07, 0.09, 0.008],
          [0, 0.044, 0],
          [-0.2, 0, 0],
        ),
        slab(
          "photo",
          "secondary",
          [0.056, 0.074, 0.001],
          [0, 0.044, 0.0045],
          [-0.2, 0, 0],
        ),
        slab(
          "stand",
          "metal-dark",
          [0.01, 0.06, 0.004],
          [0, 0.03, -0.02],
          [0.4, 0, 0],
        ),
      ];
    case "tissue-box":
      return [
        slab("box", "secondary", [0.09, 0.055, 0.06]),
        mascotShape({
          name: "tissue",
          kind: "ellipsoid",
          tint: deskSwatches.white,
          at: [0, 0.062, 0],
          radii: [0.018, 0.014, 0.012],
        }),
      ];
    case "eraser":
      return [
        slab(
          "eraser",
          deskSwatches.pink,
          [0.045, 0.012, 0.022],
          undefined,
          [0, 0.3, 0],
        ),
        slab(
          "sleeve",
          deskSwatches.blue,
          [0.02, 0.013, 0.023],
          [-0.008, 0.0065, -0.003],
          [0, 0.3, 0],
        ),
      ];
    case "highlighter":
      return [
        stick(
          "body",
          deskSwatches.yellow,
          [-0.04, 0.007, 0.01],
          [0.03, 0.007, -0.01],
          0.007,
        ),
        stick(
          "cap",
          "ink",
          [0.03, 0.007, -0.01],
          [0.047, 0.007, -0.015],
          0.0072,
        ),
      ];
    case "envelope":
      return [
        slab(
          "envelope",
          deskSwatches.white,
          [0.09, 0.003, 0.06],
          undefined,
          [0, -0.15, 0],
        ),
        slab(
          "stamp",
          "state-critical",
          [0.014, 0.001, 0.016],
          [0.03, 0.0035, -0.016],
          [0, -0.15, 0],
        ),
      ];
    case "apple":
      return [
        mascotShape({
          name: "apple",
          kind: "ellipsoid",
          tint: deskSwatches.red,
          at: [0, 0.03, 0],
          radii: [0.032, 0.03, 0.032],
        }),
        stick(
          "stalk",
          { swatch: "#4a3021" },
          [0, 0.055, 0],
          [0.004, 0.07, 0],
          0.002,
        ),
        mascotShape({
          name: "leaf",
          kind: "ellipsoid",
          tint: "plant",
          at: [0.012, 0.066, 0],
          radii: [0.01, 0.002, 0.005],
        }),
      ];
    case "trophy":
      return [
        slab("plinth", "metal-dark", [0.05, 0.02, 0.05]),
        stick("stem", deskSwatches.gold, [0, 0.02, 0], [0, 0.06, 0], 0.005),
        drum(
          "cup",
          deskSwatches.gold,
          [0, 0.06, 0],
          [0, 0.11, 0],
          [0.012, 0.03],
        ),
        ...[-1, 1].map((side) =>
          mascotShape({
            name: side === 1 ? "right handle" : "left handle",
            kind: "torus",
            tint: deskSwatches.gold,
            at: [side * 0.03, 0.09, 0],
            radius: 0.01,
            tube: 0.0025,
          }),
        ),
      ];
    case "globe":
      return [
        drum("stand", "metal-dark", [0, 0, 0], [0, 0.012, 0], [0.03, 0.035]),
        stick("axis", "metal-dark", [0, 0.012, 0], [0, 0.03, 0], 0.004),
        mascotShape({
          name: "globe",
          kind: "ellipsoid",
          tint: "state-info",
          at: [0, 0.075, 0],
          radii: [0.042, 0.042, 0.042],
        }),
        mascotShape({
          name: "meridian",
          kind: "torus",
          tint: "metal-light",
          at: [0, 0.075, 0],
          rotation: [0, Math.PI / 2, 0.4],
          radius: 0.046,
          tube: 0.002,
          arc: 0.5,
        }),
      ];
  }
}
