import type { SeasonalActorId } from "@ai-office/shared";
import type { Avatar } from "@ai-office/shared/avatar";
import { seededRandom } from "@ai-office/shared/avatar";

import type { Vec3 } from "./camera-rig.ts";
import {
  hatFrame,
  type AvatarShape,
  type Dress,
  type Tint,
} from "./avatar-parts.ts";
import type { BoneName, Rig } from "./avatar-rig.ts";

// The seasonal events' looks, all built from the Avatar kit at render time
// and never saved: each actor is an Avatar of its own with a Dress (Santa's
// hat and sack, the Elf's ears, the Grinch's fur, the skeleton's bones, the
// ghost's sheet, the witch's broom, the mummy's bandages, the Reaper's
// scythe, the drunks' glasses); Halloween dresses each Agent in a costume,
// and New Year in a party hat.

type Part = AvatarShape extends infer Each
  ? Each extends AvatarShape
    ? Omit<Each, "finish" | "detail" | "skirt"> &
        Partial<Pick<Each, "finish" | "detail">>
    : never
  : never;

/** A shape on `bone`, fabric and small unless it says otherwise. */
const part = (shape: Part): AvatarShape => ({
  finish: "fabric",
  detail: "small",
  ...shape,
});

const add = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [
  ax + bx,
  ay + by,
  az + bz,
];

const white: Tint = { swatch: "#f7f5f0" };
const black: Tint = { swatch: "#1c1c1c" };
const red: Tint = { swatch: "#c0392b" };
const green: Tint = { swatch: "#2e8b57" };
const gold: Tint = { swatch: "#d4af37" };

/** Something held in the right hand, hanging down from it at rest. */
const inHand = (rig: Rig, [x, y, z]: Vec3): Vec3 =>
  add(rig.joints.rightHand, [x * rig.scale, y * rig.scale, z * rig.scale]);

/** A glass held in the right hand: a tumbler, or a flute on a stem. */
function glass(rig: Rig, flute: boolean, drink: Tint): AvatarShape[] {
  const s = rig.scale;
  const base = inHand(rig, [0, -0.08, 0.05]);
  const glassTint: Tint = { swatch: "#dfe9ee" };
  return flute
    ? [
        part({
          name: "flute stem",
          kind: "capsule",
          bone: "rightHand",
          tint: glassTint,
          finish: "plastic",
          detail: "tiny",
          from: base,
          to: add(base, [0, 0.06 * s, 0]),
          radii: [0.004 * s, 0.004 * s],
        }),
        part({
          name: "flute",
          kind: "frustum",
          bone: "rightHand",
          tint: drink,
          finish: "plastic",
          detail: "tiny",
          from: add(base, [0, 0.06 * s, 0]),
          to: add(base, [0, 0.15 * s, 0]),
          radii: [0.012 * s, 0.02 * s],
        }),
      ]
    : [
        part({
          name: "tumbler",
          kind: "frustum",
          bone: "rightHand",
          tint: drink,
          finish: "plastic",
          detail: "tiny",
          from: base,
          to: add(base, [0, 0.09 * s, 0]),
          radii: [0.028 * s, 0.032 * s],
        }),
      ];
}

/** Pointed ears out from the sides of the head: an elf's or a wolf's. */
function pointedEars(
  rig: Rig,
  avatar: Avatar,
  tint: Tint,
  up: boolean,
): AvatarShape[] {
  const s = rig.scale;
  const { centre, over } = hatFrame(avatar, rig);
  return [-1, 1].map((side) =>
    part({
      name: `${side === -1 ? "left" : "right"} pointed ear`,
      kind: "frustum",
      bone: "head",
      tint,
      from: add(centre, [
        side * over[0] * (up ? 0.5 : 0.9),
        up ? over[1] * 0.7 : 0,
        0,
      ]),
      to: add(centre, [
        side * over[0] * (up ? 0.7 : 1.5),
        up ? over[1] * 1.3 : over[1] * 0.35,
        -0.01 * s,
      ]),
      radii: [0.035 * s, 0.003 * s],
      flatten: 0.4,
    }),
  );
}

/** A pointed hat: a cone up from the head's crown, with a brim and a tip. */
function pointedHat(
  rig: Rig,
  avatar: Avatar,
  options: {
    readonly name: string;
    readonly tint: Tint;
    readonly height: number;
    readonly lean?: number;
    readonly brim?: Tint;
    readonly brimWidth?: number;
    readonly tip?: Tint;
  },
): AvatarShape[] {
  const { centre, over, scale: s } = hatFrame(avatar, rig);
  const base = add(centre, [0, over[1] * 0.55, 0]);
  const top = add(base, [0, options.height * s, (options.lean ?? 0) * s]);
  return [
    part({
      name: options.name,
      kind: "frustum",
      bone: "head",
      tint: options.tint,
      from: base,
      to: top,
      radii: [over[0] * 0.92, 0.008 * s],
    }),
    ...(options.brim === undefined
      ? []
      : [
          part({
            name: `${options.name} brim`,
            kind: "torus",
            bone: "head",
            tint: options.brim,
            at: base,
            rotation: [Math.PI / 2, 0, 0],
            radius: over[0] * (options.brimWidth ?? 0.95),
            tube: 0.018 * s,
          }),
        ]),
    ...(options.tip === undefined
      ? []
      : [
          part({
            name: `${options.name} pompom`,
            kind: "ellipsoid",
            bone: "head",
            tint: options.tip,
            at: top,
            radii: [0.025 * s, 0.025 * s, 0.025 * s],
          }),
        ]),
  ];
}

/** A cape from the shoulders to the calves, behind. */
function cape(rig: Rig, outside: Tint, collar?: Tint): AvatarShape[] {
  const s = rig.scale;
  const neck = rig.joints.neck;
  const shoulders = rig.build.shoulders;
  return [
    part({
      name: "cape",
      kind: "frustum",
      bone: "chest",
      tint: outside,
      from: add(neck, [0, -0.02 * s, -0.09 * s]),
      to: [neck[0], 0.35 * s, neck[2] - 0.22 * s],
      radii: [shoulders * 0.55, shoulders * 0.95],
      flatten: 0.35,
    }),
    ...(collar === undefined
      ? []
      : [
          part({
            name: "cape collar",
            kind: "frustum",
            bone: "chest",
            tint: collar,
            from: add(neck, [0, -0.03 * s, -0.03 * s]),
            to: add(neck, [0, 0.13 * s, -0.06 * s]),
            radii: [0.09 * s, 0.14 * s],
            flatten: 0.6,
          }),
        ]),
  ];
}

/** Something stuck on the front of the face: eyes, a nose, a mask. */
function onFace(
  rig: Rig,
  avatar: Avatar,
  name: string,
  tint: Tint,
  at: Vec3,
  radii: Vec3,
): AvatarShape {
  const { centre } = hatFrame(avatar, rig);
  const front = rig.head.radii[2];
  return part({
    name,
    kind: "ellipsoid",
    bone: "head",
    tint,
    finish: "plastic",
    detail: "tiny",
    at: add(centre, [at[0], at[1], front * at[2]]),
    radii,
  });
}

/** Rings round a bone's middle: stripes, ribs or a belt. */
function rings(
  rig: Rig,
  name: string,
  bone: BoneName,
  tint: Tint,
  heights: readonly number[],
  radius: number,
  tube: number,
): AvatarShape[] {
  const at = rig.joints[bone];
  return heights.map((height, index) =>
    part({
      name: `${name} ${String(index + 1)}`,
      kind: "torus",
      bone,
      tint,
      at: [at[0], height * rig.scale, at[2] + 0.01 * rig.scale],
      rotation: [Math.PI / 2, 0, 0],
      radius: radius * rig.scale,
      tube: tube * rig.scale,
      scale: [1, 0.7, 1],
    }),
  );
}

const base: Avatar = {
  version: 1,
  presentation: "male",
  bodyShape: "average",
  face: "oval",
  hairstyle: "short",
  hairColour: "#1c1c1c",
  skinTone: "#e0ac69",
  facialHair: "none",
  glasses: "none",
  accessories: [],
  outfit: {
    style: "t-shirt",
    primaryColour: "#2b2b2b",
    secondaryColour: "#2b2b2b",
  },
  deskMascot: "cactus",
  deskItems: [],
};

/** Each actor: the Avatar it is built on, and its Dress. */
export const actorLooks: Readonly<
  Record<SeasonalActorId, { readonly avatar: Avatar; readonly dress: Dress }>
> = {
  santa: {
    avatar: {
      ...base,
      bodyShape: "broad",
      face: "round",
      hairstyle: "short",
      hairColour: "#f2f2f2",
      skinTone: "#f1c27d",
      facialHair: "beard",
      glasses: "round",
      outfit: {
        style: "sweater",
        primaryColour: "#c0392b",
        secondaryColour: "#f7f5f0",
      },
    },
    dress: (shapes, avatar, rig) => [
      ...shapes,
      ...pointedHat(rig, avatar, {
        name: "santa hat",
        tint: red,
        height: 0.24,
        lean: -0.08,
        brim: white,
        tip: white,
      }),
      ...rings(
        rig,
        "belt",
        "spine",
        black,
        [rig.joints.spine[1] / rig.scale],
        0.16,
        0.025,
      ),
      part({
        name: "sack",
        kind: "ellipsoid",
        bone: "chest",
        tint: { swatch: "#8b5a2b" },
        at: add(rig.joints.chest, [
          0.08 * rig.scale,
          0.02 * rig.scale,
          -0.24 * rig.scale,
        ]),
        radii: [0.2 * rig.scale, 0.24 * rig.scale, 0.16 * rig.scale],
      }),
    ],
  },
  elf: {
    avatar: {
      ...base,
      presentation: "androgynous",
      bodyShape: "slim",
      face: "heart",
      hairstyle: "bob",
      hairColour: "#c26a2b",
      skinTone: "#f1c27d",
      outfit: {
        style: "sweater",
        primaryColour: "#2e8b57",
        secondaryColour: "#c0392b",
      },
    },
    // A pointed hat with a bell, pointed ears, a belt and a red collar.
    dress: (shapes, avatar, rig) => [
      ...shapes,
      ...pointedHat(rig, avatar, {
        name: "elf hat",
        tint: green,
        height: 0.26,
        lean: -0.14,
        brim: red,
        tip: gold,
      }),
      ...pointedEars(rig, avatar, { swatch: avatar.skinTone }, false),
      ...rings(
        rig,
        "belt",
        "spine",
        black,
        [rig.joints.spine[1] / rig.scale],
        0.15,
        0.02,
      ),
      part({
        name: "collar",
        kind: "torus",
        bone: "chest",
        tint: red,
        at: add(rig.joints.neck, [0, -0.03 * rig.scale, 0]),
        rotation: [Math.PI / 2, 0, 0],
        radius: 0.09 * rig.scale,
        tube: 0.03 * rig.scale,
        sides: 6,
      }),
    ],
  },
  grinch: {
    avatar: {
      ...base,
      bodyShape: "slim",
      face: "long",
      hairstyle: "bald",
      skinTone: "#6fa83a",
      outfit: {
        style: "sweater",
        primaryColour: "#c0392b",
        secondaryColour: "#f7f5f0",
      },
    },
    // Green and furry in a stolen Santa suit and hat, with yellow eyes.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const fur: Tint = { swatch: "#5a8f2e" };
      return [
        ...shapes,
        ...pointedHat(rig, avatar, {
          name: "stolen santa hat",
          tint: red,
          height: 0.3,
          lean: -0.16,
          brim: white,
          tip: white,
        }),
        ...[-1, 1].map((side) =>
          onFace(
            rig,
            avatar,
            `${side === -1 ? "left" : "right"} yellow eye`,
            { swatch: "#e8d33f" },
            [side * 0.035 * s, 0.02 * s, 0.92],
            [0.02 * s, 0.014 * s, 0.008 * s],
          ),
        ),
        onFace(
          rig,
          avatar,
          "sly grin",
          black,
          [0.01 * s, -0.05 * s, 0.93],
          [0.04 * s, 0.006 * s, 0.006 * s],
        ),
        ...["left", "right"].map((side) =>
          part({
            name: `${side} furry cuff`,
            kind: "ellipsoid",
            bone: side === "left" ? "leftHand" : "rightHand",
            tint: fur,
            at: side === "left" ? rig.joints.leftHand : rig.joints.rightHand,
            radii: [0.045 * s, 0.03 * s, 0.045 * s],
          }),
        ),
      ];
    },
  },
  skeleton: {
    avatar: {
      ...base,
      bodyShape: "slim",
      face: "long",
      hairstyle: "bald",
      skinTone: "#e8e4da",
      outfit: {
        style: "t-shirt",
        primaryColour: "#1c1c1c",
        secondaryColour: "#1c1c1c",
      },
    },
    dress: (shapes, avatar, rig) => {
      const chest = rig.joints.chest[1] / rig.scale;
      return [
        ...shapes,
        ...rings(
          rig,
          "rib",
          "chest",
          white,
          [chest - 0.12, chest - 0.06, chest, chest + 0.06],
          0.13,
          0.012,
        ),
        ...rings(
          rig,
          "spine bone",
          "spine",
          white,
          [rig.joints.spine[1] / rig.scale],
          0.06,
          0.015,
        ),
        onFace(
          rig,
          avatar,
          "left eye socket",
          black,
          [-0.035 * rig.scale, 0.02 * rig.scale, 0.9],
          [0.022 * rig.scale, 0.026 * rig.scale, 0.01 * rig.scale],
        ),
        onFace(
          rig,
          avatar,
          "right eye socket",
          black,
          [0.035 * rig.scale, 0.02 * rig.scale, 0.9],
          [0.022 * rig.scale, 0.026 * rig.scale, 0.01 * rig.scale],
        ),
        onFace(
          rig,
          avatar,
          "nose hole",
          black,
          [0, -0.025 * rig.scale, 0.95],
          [0.01 * rig.scale, 0.012 * rig.scale, 0.008 * rig.scale],
        ),
      ];
    },
  },
  vampire: {
    avatar: {
      ...base,
      bodyShape: "slim",
      face: "long",
      hairstyle: "short",
      hairColour: "#1c1c1c",
      skinTone: "#f2efe6",
      outfit: {
        style: "blazer",
        primaryColour: "#1c1c1c",
        secondaryColour: "#8c2f39",
      },
    },
    dress: (shapes, avatar, rig) => [
      ...shapes,
      ...cape(rig, black, red),
      onFace(
        rig,
        avatar,
        "left fang",
        white,
        [-0.012 * rig.scale, -0.06 * rig.scale, 0.85],
        [0.004 * rig.scale, 0.01 * rig.scale, 0.004 * rig.scale],
      ),
      onFace(
        rig,
        avatar,
        "right fang",
        white,
        [0.012 * rig.scale, -0.06 * rig.scale, 0.85],
        [0.004 * rig.scale, 0.01 * rig.scale, 0.004 * rig.scale],
      ),
    ],
  },
  ghost: {
    avatar: { ...base, hairstyle: "bald", skinTone: "#f7f5f0" },
    // Under a sheet: nothing of the Avatar shows but the sheet, its head
    // and its eyes.
    dress: (_shapes, avatar, rig) => {
      const s = rig.scale;
      const { centre, over } = hatFrame(avatar, rig);
      return [
        part({
          name: "sheet",
          kind: "frustum",
          bone: "spine",
          tint: white,
          from: [0, centre[1] - over[1] * 0.4, 0],
          to: [0, 0.08 * s, 0],
          radii: [over[0] * 1.15, 0.36 * s],
        }),
        part({
          name: "sheet head",
          kind: "dome",
          bone: "head",
          tint: white,
          at: centre,
          radii: [over[0] * 1.2, over[1] * 1.25, over[2] * 1.2],
          cut: 0.9,
        }),
        onFace(
          rig,
          avatar,
          "left eye",
          black,
          [-0.04 * s, 0.01 * s, 1.15],
          [0.018 * s, 0.03 * s, 0.01 * s],
        ),
        onFace(
          rig,
          avatar,
          "right eye",
          black,
          [0.04 * s, 0.01 * s, 1.15],
          [0.018 * s, 0.03 * s, 0.01 * s],
        ),
        onFace(
          rig,
          avatar,
          "mouth",
          black,
          [0, -0.05 * s, 1.12],
          [0.02 * s, 0.028 * s, 0.01 * s],
        ),
      ];
    },
  },
  slasher: {
    avatar: {
      ...base,
      bodyShape: "broad",
      hairstyle: "crop",
      hairColour: "#4a3021",
      outfit: {
        style: "overalls",
        primaryColour: "#4a4f3a",
        secondaryColour: "#4a4f3a",
      },
    },
    // A boiler suit and a plain white mask with dark holes.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      return [
        ...shapes,
        onFace(
          rig,
          avatar,
          "mask",
          white,
          [0, 0, 0.55],
          [
            rig.head.radii[0] * 0.95,
            rig.head.radii[1] * 1.0,
            rig.head.radii[2] * 0.6,
          ],
        ),
        onFace(
          rig,
          avatar,
          "left mask eye",
          black,
          [-0.035 * s, 0.02 * s, 1.1],
          [0.016 * s, 0.012 * s, 0.006 * s],
        ),
        onFace(
          rig,
          avatar,
          "right mask eye",
          black,
          [0.035 * s, 0.02 * s, 1.1],
          [0.016 * s, 0.012 * s, 0.006 * s],
        ),
        onFace(
          rig,
          avatar,
          "mask mouth",
          black,
          [0, -0.05 * s, 1.08],
          [0.02 * s, 0.006 * s, 0.006 * s],
        ),
      ];
    },
  },
  "night-stalker": {
    avatar: {
      ...base,
      bodyShape: "slim",
      face: "long",
      hairstyle: "short",
      hairColour: "#4a3021",
      skinTone: "#c68642",
      outfit: {
        style: "sweater",
        primaryColour: "#5b4b8a",
        secondaryColour: "#2b2b2b",
      },
    },
    // A battered wide-brimmed hat, a striped jumper and spiky fingers.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const { centre, over } = hatFrame(avatar, rig);
      const chest = rig.joints.chest[1] / s;
      const hand = rig.joints.rightHand;
      return [
        ...shapes,
        part({
          name: "hat crown",
          kind: "frustum",
          bone: "head",
          tint: { swatch: "#4a3021" },
          from: add(centre, [0, over[1] * 0.45, 0]),
          to: add(centre, [0, over[1] * 1.25, 0]),
          radii: [over[0] * 0.95, over[0] * 0.8],
        }),
        part({
          name: "hat brim",
          kind: "ellipsoid",
          bone: "head",
          tint: { swatch: "#4a3021" },
          at: add(centre, [0, over[1] * 0.5, 0]),
          rotation: [0.12, 0, 0],
          radii: [over[0] * 1.7, 0.008 * s, over[2] * 1.7],
        }),
        ...rings(
          rig,
          "stripe",
          "chest",
          { swatch: "#2b2b2b" },
          [chest - 0.1, chest - 0.02, chest + 0.06],
          0.16,
          0.014,
        ),
        ...[-1, 0, 1].map((finger) =>
          part({
            name: `spike ${String(finger + 2)}`,
            kind: "capsule",
            bone: "rightHand",
            tint: "metal-light",
            finish: "metal",
            from: add(hand, [finger * 0.015 * s, -0.06 * s, 0.01 * s]),
            to: add(hand, [finger * 0.02 * s, -0.17 * s, 0.03 * s]),
            radii: [0.005 * s, 0.002 * s],
          }),
        ),
      ];
    },
  },
  "creepy-clown": {
    avatar: {
      ...base,
      face: "round",
      hairstyle: "afro",
      hairColour: "#e07a5f",
      skinTone: "#f7f5f0",
      outfit: {
        style: "overalls",
        primaryColour: "#d64f8f",
        secondaryColour: "#d98e04",
      },
    },
    // A red nose, a ruff and pompoms down the front.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const chest = rig.joints.chest;
      return [
        ...shapes,
        onFace(
          rig,
          avatar,
          "nose",
          red,
          [0, -0.01 * s, 1.05],
          [0.024 * s, 0.024 * s, 0.024 * s],
        ),
        onFace(
          rig,
          avatar,
          "left eye paint",
          { swatch: "#2e6fd8" },
          [-0.035 * s, 0.03 * s, 0.9],
          [0.012 * s, 0.03 * s, 0.006 * s],
        ),
        onFace(
          rig,
          avatar,
          "right eye paint",
          { swatch: "#2e6fd8" },
          [0.035 * s, 0.03 * s, 0.9],
          [0.012 * s, 0.03 * s, 0.006 * s],
        ),
        part({
          name: "ruff",
          kind: "torus",
          bone: "chest",
          tint: white,
          at: add(rig.joints.neck, [0, -0.02 * s, 0]),
          rotation: [Math.PI / 2, 0, 0],
          radius: 0.09 * s,
          tube: 0.035 * s,
          sides: 8,
        }),
        ...[0, 1, 2].map((index) =>
          part({
            name: `pompom ${String(index + 1)}`,
            kind: "ellipsoid",
            bone: "chest",
            tint: { swatch: "#ffe066" },
            at: add(chest, [0, (0.08 - index * 0.1) * s, 0.13 * s]),
            radii: [0.025 * s, 0.025 * s, 0.025 * s],
          }),
        ),
      ];
    },
  },
  werewolf: {
    avatar: {
      ...base,
      bodyShape: "broad",
      face: "square",
      hairstyle: "curly",
      hairColour: "#4a3021",
      skinTone: "#7a5434",
      facialHair: "beard",
      outfit: {
        style: "shirt",
        primaryColour: "#8c2f39",
        secondaryColour: "#2b2b2b",
      },
    },
    // Wolf's ears, a snout and claws, and a torn plaid shirt.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const fur: Tint = { swatch: "#4a3021" };
      return [
        ...shapes,
        ...pointedEars(rig, avatar, fur, true),
        onFace(
          rig,
          avatar,
          "snout",
          fur,
          [0, -0.03 * s, 1.05],
          [0.035 * s, 0.03 * s, 0.05 * s],
        ),
        onFace(
          rig,
          avatar,
          "wolf nose",
          black,
          [0, -0.015 * s, 1.5],
          [0.014 * s, 0.01 * s, 0.01 * s],
        ),
        ...(["leftHand", "rightHand"] as const).flatMap((hand) =>
          [-1, 0, 1].map((finger) =>
            part({
              name: `${hand} claw ${String(finger + 2)}`,
              kind: "frustum",
              bone: hand,
              tint: { swatch: "#e8e4da" },
              finish: "plastic",
              detail: "tiny",
              from: add(rig.joints[hand], [
                finger * 0.015 * s,
                -0.07 * s,
                0.01 * s,
              ]),
              to: add(rig.joints[hand], [
                finger * 0.016 * s,
                -0.11 * s,
                0.025 * s,
              ]),
              radii: [0.006 * s, 0.001 * s],
            }),
          ),
        ),
      ];
    },
  },
  witch: {
    avatar: {
      ...base,
      presentation: "female",
      bodyShape: "slim",
      face: "long",
      hairstyle: "long",
      hairColour: "#1c1c1c",
      skinTone: "#9acd8a",
      outfit: {
        style: "dress",
        primaryColour: "#2b2b2b",
        secondaryColour: "#5b4b8a",
      },
    },
    // A tall pointed hat, a long nose with a wart, and a broomstick.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const wood: Tint = { swatch: "#8b5a2b" };
      const top = inHand(rig, [0, 0.35, 0.04]);
      const bottom = inHand(rig, [0, -0.75, 0.04]);
      return [
        ...shapes,
        ...pointedHat(rig, avatar, {
          name: "witch hat",
          tint: { swatch: "#2b2b2b" },
          height: 0.34,
          lean: -0.1,
          brim: { swatch: "#2b2b2b" },
          brimWidth: 1.6,
        }),
        onFace(
          rig,
          avatar,
          "long nose",
          { swatch: avatar.skinTone },
          [0, 0, 1.1],
          [0.014 * s, 0.016 * s, 0.05 * s],
        ),
        onFace(
          rig,
          avatar,
          "wart",
          { swatch: "#6b8f5a" },
          [0.01 * s, 0.004 * s, 1.45],
          [0.006 * s, 0.006 * s, 0.006 * s],
        ),
        part({
          name: "broomstick",
          kind: "capsule",
          bone: "rightHand",
          tint: wood,
          from: bottom,
          to: top,
          radii: [0.012 * s, 0.012 * s],
        }),
        part({
          name: "broom bristles",
          kind: "frustum",
          bone: "rightHand",
          tint: { swatch: "#c9a45c" },
          from: add(bottom, [0, 0.12 * s, 0]),
          to: add(bottom, [0, -0.12 * s, 0]),
          radii: [0.02 * s, 0.07 * s],
        }),
      ];
    },
  },
  mummy: {
    avatar: {
      ...base,
      hairstyle: "bald",
      skinTone: "#d8cfb4",
      outfit: {
        style: "t-shirt",
        primaryColour: "#d8cfb4",
        secondaryColour: "#d8cfb4",
      },
    },
    // Wrapped in bandages head to foot, a dark slit for the eyes.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const bandage: Tint = { swatch: "#ece4cc" };
      const { centre } = hatFrame(avatar, rig);
      const chest = rig.joints.chest[1] / s;
      const spine = rig.joints.spine[1] / s;
      const hips = rig.joints.hips[1] / s;
      const head = centre[1] / s;
      return [
        ...shapes,
        ...rings(
          rig,
          "chest bandage",
          "chest",
          bandage,
          [chest - 0.12, chest - 0.05, chest + 0.02, chest + 0.09],
          0.15,
          0.015,
        ),
        ...rings(
          rig,
          "waist bandage",
          "spine",
          bandage,
          [spine - 0.04, spine + 0.04],
          0.14,
          0.015,
        ),
        ...rings(
          rig,
          "hip bandage",
          "hips",
          bandage,
          [hips - 0.05, hips + 0.03],
          0.15,
          0.015,
        ),
        ...rings(
          rig,
          "head bandage",
          "head",
          bandage,
          [head - 0.06, head + 0.04, head + 0.09],
          0.095,
          0.012,
        ),
        onFace(
          rig,
          avatar,
          "eye slit",
          black,
          [0, 0.015 * s, 0.92],
          [0.06 * s, 0.01 * s, 0.008 * s],
        ),
      ];
    },
  },
  zombie: {
    avatar: {
      ...base,
      face: "square",
      hairstyle: "short",
      hairColour: "#3a3a2a",
      skinTone: "#8fa37a",
      outfit: {
        style: "shirt",
        primaryColour: "#6b7c8f",
        secondaryColour: "#4a4f3a",
      },
    },
    // Grey-green and rotting: sunken eyes, a gash and a bloodied shirt.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const blood: Tint = { swatch: "#7a1c1c" };
      return [
        ...shapes,
        ...[-1, 1].map((side) =>
          onFace(
            rig,
            avatar,
            `${side === -1 ? "left" : "right"} sunken eye`,
            { swatch: "#3a2a2a" },
            [side * 0.035 * s, 0.02 * s, 0.9],
            [0.022 * s, 0.018 * s, 0.008 * s],
          ),
        ),
        onFace(
          rig,
          avatar,
          "gash",
          blood,
          [0.03 * s, 0.06 * s, 0.85],
          [0.025 * s, 0.005 * s, 0.006 * s],
        ),
        part({
          name: "bloodstain",
          kind: "ellipsoid",
          bone: "chest",
          tint: blood,
          at: add(rig.joints.chest, [0.04 * s, -0.04 * s, 0.13 * s]),
          radii: [0.05 * s, 0.06 * s, 0.01 * s],
        }),
      ];
    },
  },
  monster: {
    avatar: {
      ...base,
      bodyShape: "broad",
      face: "square",
      hairstyle: "crop",
      hairColour: "#1c1c1c",
      skinTone: "#7fa86b",
      outfit: {
        style: "blazer",
        primaryColour: "#2b2b2b",
        secondaryColour: "#4a4f3a",
      },
    },
    // A flat top, bolts through the neck and a stitched scar.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const { centre, over } = hatFrame(avatar, rig);
      const neck = rig.joints.neck;
      return [
        ...shapes,
        part({
          name: "flat top",
          kind: "box",
          bone: "head",
          tint: { swatch: "#1c1c1c" },
          at: add(centre, [0, over[1] * 0.85, 0]),
          size: [over[0] * 1.9, 0.05 * s, over[2] * 1.8],
        }),
        ...[-1, 1].map((side) =>
          part({
            name: `${side === -1 ? "left" : "right"} neck bolt`,
            kind: "capsule",
            bone: "neck",
            tint: "metal-light",
            finish: "metal",
            from: add(neck, [side * 0.05 * s, 0.03 * s, 0]),
            to: add(neck, [side * 0.1 * s, 0.03 * s, 0]),
            radii: [0.012 * s, 0.012 * s],
          }),
        ),
        onFace(
          rig,
          avatar,
          "scar",
          black,
          [-0.02 * s, 0.07 * s, 0.85],
          [0.04 * s, 0.004 * s, 0.005 * s],
        ),
        ...[-1, 0, 1].map((stitch) =>
          onFace(
            rig,
            avatar,
            `stitch ${String(stitch + 2)}`,
            black,
            [-0.02 * s + stitch * 0.02 * s, 0.07 * s, 0.86],
            [0.002 * s, 0.012 * s, 0.004 * s],
          ),
        ),
      ];
    },
  },
  "grim-reaper": {
    avatar: {
      ...base,
      bodyShape: "slim",
      face: "long",
      hairstyle: "bald",
      skinTone: "#e8e4da",
      outfit: {
        style: "sweater",
        primaryColour: "#141414",
        secondaryColour: "#141414",
      },
    },
    // A long black robe and hood over a skull, and a scythe.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const { centre, over } = hatFrame(avatar, rig);
      const robe: Tint = { swatch: "#141414" };
      const top = inHand(rig, [0, 0.9, 0.05]);
      const bottom = inHand(rig, [0, -0.7, 0.05]);
      return [
        ...shapes,
        part({
          name: "robe",
          kind: "frustum",
          bone: "spine",
          tint: robe,
          from: add(rig.joints.neck, [0, -0.02 * s, -0.01 * s]),
          to: [0, 0.03 * s, 0],
          radii: [0.1 * s, 0.24 * s],
        }),
        part({
          name: "hood",
          kind: "ellipsoid",
          bone: "head",
          tint: robe,
          at: add(centre, [0, over[1] * 0.12, -over[2] * 0.25]),
          radii: [over[0] * 1.25, over[1] * 1.3, over[2] * 1.1],
        }),
        ...[-1, 1].map((side) =>
          onFace(
            rig,
            avatar,
            `${side === -1 ? "left" : "right"} eye socket`,
            black,
            [side * 0.035 * s, 0.02 * s, 0.92],
            [0.022 * s, 0.026 * s, 0.01 * s],
          ),
        ),
        part({
          name: "scythe handle",
          kind: "capsule",
          bone: "rightHand",
          tint: { swatch: "#5a3a1f" },
          from: bottom,
          to: top,
          radii: [0.012 * s, 0.012 * s],
        }),
        part({
          name: "scythe blade",
          kind: "torus",
          bone: "rightHand",
          tint: "metal-light",
          finish: "metal",
          at: add(top, [0, -0.15 * s, 0.2 * s]),
          rotation: [0, Math.PI / 2, 0],
          radius: 0.25 * s,
          tube: 0.012 * s,
          arc: 0.3,
          scale: [1, 1, 0.3],
        }),
      ];
    },
  },
  "easter-bunny": {
    avatar: {
      ...base,
      bodyShape: "curvy",
      face: "round",
      hairstyle: "bald",
      skinTone: "#f7f5f0",
      outfit: {
        style: "overalls",
        primaryColour: "#f4a6b7",
        secondaryColour: "#f7f5f0",
      },
    },
    // Long ears, a pink nose, buck teeth and a fluffy tail.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const { centre, over } = hatFrame(avatar, rig);
      const hips = rig.joints.hips;
      return [
        ...shapes,
        ...[-1, 1].flatMap((side) => [
          part({
            name: `${side === -1 ? "left" : "right"} ear`,
            kind: "ellipsoid",
            bone: "head",
            tint: white,
            at: add(centre, [side * over[0] * 0.45, over[1] * 1.6, 0]),
            rotation: [0, 0, side * -0.15],
            radii: [0.035 * s, 0.14 * s, 0.025 * s],
          }),
          part({
            name: `${side === -1 ? "left" : "right"} inner ear`,
            kind: "ellipsoid",
            bone: "head",
            tint: { swatch: "#f4a6b7" },
            at: add(centre, [side * over[0] * 0.45, over[1] * 1.6, 0.012 * s]),
            rotation: [0, 0, side * -0.15],
            radii: [0.02 * s, 0.11 * s, 0.018 * s],
          }),
        ]),
        onFace(
          rig,
          avatar,
          "nose",
          { swatch: "#f4a6b7" },
          [0, 0, 1.02],
          [0.016 * s, 0.012 * s, 0.012 * s],
        ),
        onFace(
          rig,
          avatar,
          "teeth",
          white,
          [0, -0.045 * s, 0.97],
          [0.014 * s, 0.014 * s, 0.006 * s],
        ),
        part({
          name: "tail",
          kind: "ellipsoid",
          bone: "hips",
          tint: white,
          at: add(hips, [0, 0, -0.16 * s]),
          radii: [0.06 * s, 0.06 * s, 0.06 * s],
        }),
      ];
    },
  },
  "drunk-man": {
    avatar: {
      ...base,
      bodyShape: "average",
      face: "round",
      hairstyle: "short",
      hairColour: "#4a3021",
      skinTone: "#e0ac69",
      facialHair: "stubble",
      outfit: {
        style: "shirt",
        primaryColour: "#f2f2f2",
        secondaryColour: "#1c1c1c",
      },
    },
    // A party hat askew, a loosened tie, a red nose and a glass.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      return [
        ...shapes,
        ...pointedHat(rig, avatar, {
          name: "party hat",
          tint: { swatch: "#2e6fd8" },
          height: 0.2,
          lean: 0.08,
          tip: { swatch: "#ffe066" },
        }),
        part({
          name: "loose tie",
          kind: "box",
          bone: "chest",
          tint: red,
          at: add(rig.joints.chest, [0.03 * s, -0.04 * s, 0.13 * s]),
          rotation: [0, 0, 0.35],
          size: [0.04 * s, 0.22 * s, 0.01 * s],
        }),
        onFace(
          rig,
          avatar,
          "red nose",
          { swatch: "#d9534f" },
          [0, -0.01 * s, 1.02],
          [0.02 * s, 0.018 * s, 0.018 * s],
        ),
        ...glass(rig, false, { swatch: "#d98e04" }),
      ];
    },
  },
  "drunk-woman": {
    avatar: {
      ...base,
      presentation: "female",
      bodyShape: "curvy",
      face: "heart",
      hairstyle: "long",
      hairColour: "#e3c16f",
      skinTone: "#f1c27d",
      outfit: {
        style: "dress",
        primaryColour: "#d4af37",
        secondaryColour: "#d64f8f",
      },
    },
    // A sparkly dress, a tiara, rosy cheeks and a flute of fizz.
    dress: (shapes, avatar, rig) => {
      const s = rig.scale;
      const { centre, over } = hatFrame(avatar, rig);
      return [
        ...shapes,
        part({
          name: "tiara",
          kind: "torus",
          bone: "head",
          tint: "metal-light",
          finish: "metal",
          at: add(centre, [0, over[1] * 0.75, 0.01 * s]),
          rotation: [Math.PI / 2 - 0.3, 0, 0],
          radius: over[0] * 0.8,
          tube: 0.008 * s,
          arc: 0.5,
        }),
        ...[-1, 1].map((side) =>
          onFace(
            rig,
            avatar,
            `${side === -1 ? "left" : "right"} rosy cheek`,
            { swatch: "#e88a9a" },
            [side * 0.045 * s, -0.025 * s, 0.85],
            [0.018 * s, 0.012 * s, 0.006 * s],
          ),
        ),
        ...glass(rig, true, { swatch: "#f3e5ab" }),
      ];
    },
  },
};

/** The Halloween costumes the Agents wear, one each, by their id. */
export const costumes = [
  "witch hat",
  "devil horns",
  "cat ears",
  "cape",
] as const;
export type Costume = (typeof costumes)[number];

/** An Agent's Halloween costume: the same one for the same Agent. */
export const costumeOf = (agentId: string): Costume =>
  costumes[
    Math.floor(seededRandom(`costume:${agentId}`)() * costumes.length)
  ] ?? "witch hat";

/** A Halloween costume, over the Agent's own clothes. */
export function costumeDress(costume: Costume): Dress {
  return (shapes, avatar, rig) => {
    const s = rig.scale;
    const { centre, over } = hatFrame(avatar, rig);
    switch (costume) {
      case "witch hat":
        return [
          ...shapes,
          ...pointedHat(rig, avatar, {
            name: "witch hat",
            tint: { swatch: "#2b2b2b" },
            height: 0.3,
            lean: -0.06,
            brim: { swatch: "#2b2b2b" },
            brimWidth: 1.5,
          }),
        ];
      case "devil horns":
        return [
          ...shapes,
          ...[-1, 1].map((side) =>
            part({
              name: `${side === -1 ? "left" : "right"} horn`,
              kind: "frustum",
              bone: "head",
              tint: red,
              finish: "plastic",
              from: add(centre, [side * over[0] * 0.5, over[1] * 0.75, 0]),
              to: add(centre, [
                side * over[0] * 0.75,
                over[1] * 1.35,
                0.01 * s,
              ]),
              radii: [0.022 * s, 0.003 * s],
            }),
          ),
        ];
      case "cat ears":
        return [
          ...shapes,
          ...[-1, 1].map((side) =>
            part({
              name: `${side === -1 ? "left" : "right"} cat ear`,
              kind: "frustum",
              bone: "head",
              tint: black,
              from: add(centre, [side * over[0] * 0.55, over[1] * 0.75, 0]),
              to: add(centre, [side * over[0] * 0.7, over[1] * 1.25, 0]),
              radii: [0.04 * s, 0.004 * s],
              flatten: 0.4,
            }),
          ),
        ];
      case "cape":
        return [...shapes, ...cape(rig, black, red)];
    }
  };
}

/** A New Year party hat, in one of a few bright colours by the Agent's id. */
export function partyHatDress(agentId: string): Dress {
  const colours = ["#d64f8f", "#2e6fd8", "#d98e04", "#81b29a", "#5b4b8a"];
  const colour =
    colours[Math.floor(seededRandom(`party:${agentId}`)() * colours.length)] ??
    "#d64f8f";
  return (shapes, avatar, rig) => [
    ...shapes,
    ...pointedHat(rig, avatar, {
      name: "party hat",
      tint: { swatch: colour },
      height: 0.2,
      tip: { swatch: "#ffe066" },
    }),
  ];
}

/**
 * What an Agent wears in season, if anything: its Halloween costume, a
 * New Year party hat, or both on the day they meet.
 */
export function seasonalDress(
  agentId: string,
  season: { readonly costumes: boolean; readonly partyHats: boolean },
): Dress | undefined {
  const dresses = [
    ...(season.costumes ? [costumeDress(costumeOf(agentId))] : []),
    ...(season.partyHats ? [partyHatDress(agentId)] : []),
  ];
  return dresses.length === 0
    ? undefined
    : (shapes, avatar, rig) =>
        dresses.reduce<AvatarShape[]>(
          (worn, dress) => dress(worn, avatar, rig),
          [...shapes],
        );
}
