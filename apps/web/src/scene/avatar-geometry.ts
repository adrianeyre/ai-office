import {
  randomAvatar,
  seededRandom,
  type Avatar,
  type DeskItemKind,
} from "@ai-office/shared/avatar";
import { palette } from "@ai-office/shared/palette";
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  Color,
  DataTexture,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  MeshStandardMaterial,
  NearestFilter,
  Quaternion,
  QuaternionKeyframeTrack,
  RGBAFormat,
  Skeleton,
  Uint16BufferAttribute,
  Vector3,
  VectorKeyframeTrack,
} from "three";

import type { Vec3 } from "./camera-rig.ts";
import {
  animationNames,
  animationSpec,
  type AnimationName,
  type AnimationSpec,
  type AvatarProp,
  type Pose,
} from "./avatar-animations.ts";
import {
  avatarFinishes,
  avatarShapes,
  deskItemShapes,
  mascotShapes,
  type AvatarFinish,
  type AvatarShape,
  type AvatarSlot,
  type Dress,
  type ShapeDetail,
  type Tint,
  type UnboundShape,
} from "./avatar-parts.ts";
import {
  avatarRig,
  boneNames,
  boneParents,
  type BoneName,
  type Rig,
} from "./avatar-rig.ts";
import type { QualityLevel } from "./quality.ts";

// The character kit (avatar-parts.ts) as three.js: an Avatar's shapes made
// into one skinned mesh on the shared rig, tinted by vertex colour, in one
// material shared by every Avatar, so each Avatar is one draw call. Each
// surface's finish (skin, hair, fabric, plastic, metal) is a texel of a
// tiny roughness-metalness map that its vertices point at. Its animations
// (avatar-animations.ts) become clips, and its props (a mug, a ticket) and
// desk mascot meshes of their own.

/**
 * How finely an Avatar is made (the spec's LODs): LOD0 at High's count,
 * LOD1 about half, LOD2 about a quarter. Each quality setting uses the
 * finest its column allows.
 */
export type AvatarLod = 0 | 1 | 2;
export const avatarLods: Readonly<Record<QualityLevel, AvatarLod>> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** The spec's triangle budget for an Avatar at each quality setting. */
export const avatarTriangleBudget: Readonly<Record<QualityLevel, number>> = {
  low: 3000,
  medium: 6000,
  high: 10_000,
};

/** Sides around and rings along a large shape, at each LOD. */
const lodSegments: Readonly<
  Record<AvatarLod, { readonly around: number; readonly along: number }>
> = {
  0: { around: 16, along: 10 },
  1: { around: 11, along: 7 },
  2: { around: 8, along: 5 },
};

const detailScale: Readonly<Record<ShapeDetail, number>> = {
  large: 1,
  small: 0.6,
  tiny: 0.4,
};

const segmentsFor = (detail: ShapeDetail, lod: AvatarLod) => ({
  around: Math.max(
    4,
    Math.round(lodSegments[lod].around * detailScale[detail]),
  ),
  along: Math.max(2, Math.round(lodSegments[lod].along * detailScale[detail])),
});

/** Positions and triangles, about a shape's own origin. */
interface Mesh {
  readonly positions: number[];
  readonly indices: number[];
}

/**
 * A surface of revolution about +y from bands of profile points, top to
 * bottom, each `[radius, y]`. A point of radius 0 is a pole, one vertex;
 * the bands are not joined to each other, so their edges stay sharp.
 */
function lathe(
  bands: readonly (readonly (readonly [number, number])[])[],
  around: number,
): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const band of bands) {
    const rows = band.map(([radius, y]) => {
      const first = positions.length / 3;
      if (radius < 1e-9) {
        positions.push(0, y, 0);
        return { first, pole: true };
      }
      for (let side = 0; side < around; side += 1) {
        const angle = (side / around) * Math.PI * 2;
        positions.push(radius * Math.sin(angle), y, radius * Math.cos(angle));
      }
      return { first, pole: false };
    });
    for (let row = 0; row + 1 < rows.length; row += 1) {
      const top = rows[row];
      const bottom = rows[row + 1];
      if (
        top === undefined ||
        bottom === undefined ||
        (top.pole && bottom.pole)
      ) {
        continue;
      }
      for (let side = 0; side < around; side += 1) {
        const next = (side + 1) % around;
        if (top.pole && !bottom.pole) {
          indices.push(top.first, bottom.first + side, bottom.first + next);
        } else if (bottom.pole && !top.pole) {
          indices.push(top.first + side, bottom.first, top.first + next);
        } else {
          const a = top.first + side;
          const b = top.first + next;
          const c = bottom.first + side;
          const d = bottom.first + next;
          indices.push(a, c, d, a, d, b);
        }
      }
    }
  }
  return { positions, indices };
}

/** A unit sphere's profile, down to `cut` of the way from top to bottom. */
const sphereProfile = (along: number, cut = 1) =>
  Array.from({ length: along + 1 }, (_, ring) => {
    const angle = (ring / along) * Math.PI * cut;
    return [Math.sin(angle), Math.cos(angle)] as const;
  });

function boxMesh([width, height, depth]: Vec3): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = [width / 2, height / 2, depth / 2] as const;
  // Each face: its normal axis and sign; its corners go round it.
  for (const axis of [0, 1, 2] as const) {
    for (const sign of [1, -1] as const) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const first = positions.length / 3;
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const corner = [0, 0, 0];
        corner[axis] = sign * half[axis];
        corner[u] = a * (half[u] ?? 0);
        corner[v] = b * (half[v] ?? 0);
        positions.push(...corner);
      }
      if (sign === 1) {
        indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      } else {
        indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
      }
    }
  }
  return { positions, indices };
}

function torusMesh(
  radius: number,
  tube: number,
  sides: number,
  tubeSides: number,
  arc: number,
): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const closed = arc >= 1;
  const rings = closed ? sides : sides + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    const u = (ring / sides) * Math.PI * 2 * arc;
    for (let side = 0; side < tubeSides; side += 1) {
      const v = (side / tubeSides) * Math.PI * 2;
      const across = radius + tube * Math.cos(v);
      positions.push(
        across * Math.cos(u),
        across * Math.sin(u),
        tube * Math.sin(v),
      );
    }
  }
  for (let ring = 0; ring < sides; ring += 1) {
    const next = closed ? (ring + 1) % rings : ring + 1;
    for (let side = 0; side < tubeSides; side += 1) {
      const nextSide = (side + 1) % tubeSides;
      const a = ring * tubeSides + side;
      const b = ring * tubeSides + nextSide;
      const c = next * tubeSides + side;
      const d = next * tubeSides + nextSide;
      indices.push(a, c, d, a, d, b);
    }
  }
  return { positions, indices };
}

const up = new Vector3(0, 1, 0);

/** A shape's triangles, in place in the model. */
function shapeMesh(shape: UnboundShape, lod: AvatarLod): Mesh {
  const { around, along } = segmentsFor(shape.detail, lod);
  const matrix = new Matrix4();
  let mesh: Mesh;
  if (shape.kind === "capsule" || shape.kind === "frustum") {
    const from = new Vector3(...shape.from);
    const direction = new Vector3(...shape.to).sub(from);
    const length = direction.length();
    const [bottom, top] = shape.radii;
    if (shape.kind === "capsule") {
      const caps = Math.max(2, Math.round(along / 2));
      mesh = lathe(
        [
          [
            ...sphereProfile(caps, 0.5).map(
              ([r, y]) => [r * top, length + y * top] as const,
            ),
            ...sphereProfile(caps * 2, 1)
              .slice(caps)
              .map(([r, y]) => [r * bottom, y * bottom] as const),
          ],
        ],
        around,
      );
    } else {
      mesh = lathe(
        [
          [
            [0, length],
            [top, length],
          ],
          [
            [top, length],
            [bottom, 0],
          ],
          [
            [bottom, 0],
            [0, 0],
          ],
        ],
        around,
      );
    }
    matrix.compose(
      from,
      new Quaternion().setFromUnitVectors(up, direction.normalize()),
      new Vector3(1, 1, shape.flatten ?? 1),
    );
  } else {
    let size: Vec3 = [1, 1, 1];
    if (shape.kind === "ellipsoid") {
      mesh = lathe([sphereProfile(along)], around);
      size = shape.radii;
    } else if (shape.kind === "dome") {
      const rings = Math.max(2, Math.round(along * shape.cut * 1.4));
      mesh = lathe([sphereProfile(rings, shape.cut)], around);
      size = shape.radii;
    } else if (shape.kind === "box") {
      mesh = boxMesh(shape.size);
    } else {
      mesh = torusMesh(
        shape.radius,
        shape.tube,
        shape.sides ?? Math.max(6, Math.round(around * (shape.arc ?? 1))),
        Math.max(3, Math.round(along * 0.6)),
        shape.arc ?? 1,
      );
      size = shape.scale ?? [1, 1, 1];
    }
    matrix.compose(
      new Vector3(...shape.at),
      new Quaternion().setFromEuler(
        new Euler(...(shape.rotation ?? [0, 0, 0])),
      ),
      new Vector3(...size),
    );
  }
  const point = new Vector3();
  const positions = mesh.positions.slice();
  for (let index = 0; index < positions.length; index += 3) {
    point.fromArray(positions, index).applyMatrix4(matrix);
    point.toArray(positions, index);
  }
  return { positions, indices: mesh.indices };
}

const slotColour = (avatar: Avatar, slot: AvatarSlot): string =>
  ({
    skin: avatar.skinTone,
    hair: avatar.hairColour,
    primary: avatar.outfit.primaryColour,
    secondary: avatar.outfit.secondaryColour,
  })[slot];

const isSlot = (tint: string): tint is AvatarSlot =>
  ["skin", "hair", "primary", "secondary"].includes(tint);

/** A tint's colour for an Avatar, as three.js's linear colour. */
export function tintColour(avatar: Avatar, tint: Tint): Color {
  if (typeof tint === "string") {
    return new Color(isSlot(tint) ? slotColour(avatar, tint) : palette[tint]);
  }
  if ("swatch" in tint) {
    return new Color(tint.swatch);
  }
  const [from, to] = tint.mix;
  return new Color(slotColour(avatar, from)).lerp(
    new Color(slotColour(avatar, to)),
    tint.amount,
  );
}

const finishOrder = Object.keys(avatarFinishes) as AvatarFinish[];
/** The finish map's width, in texels: one per finish, and room to spare. */
const finishTexels = 8;

/** Where a finish's texel is, across the map. */
export const finishU = (finish: AvatarFinish) =>
  (finishOrder.indexOf(finish) + 0.5) / finishTexels;

/** The finish map: roughness in green and metalness in blue, as three.js reads them. */
function finishMap(): DataTexture {
  const data = new Uint8Array(finishTexels * 4);
  finishOrder.forEach((finish, index) => {
    const { roughness, metalness } = avatarFinishes[finish];
    data.set(
      [255, Math.round(roughness * 255), metalness * 255, 255],
      index * 4,
    );
  });
  const texture = new DataTexture(data, finishTexels, 1, RGBAFormat);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

let sharedMaterial: MeshStandardMaterial | undefined;

/** The one material every Avatar, prop and desk mascot shares. */
export function avatarMaterial(): MeshStandardMaterial {
  if (sharedMaterial === undefined) {
    const finishes = finishMap();
    sharedMaterial = new MeshStandardMaterial({
      name: "avatar/finishes",
      vertexColors: true,
      // The map's texels set each surface's own; these multiply them.
      roughness: 1,
      metalness: 1,
      roughnessMap: finishes,
      metalnessMap: finishes,
    });
  }
  return sharedMaterial;
}

/** Shapes made into one geometry: positions, colours, finishes and, for a rig, skinning. */
function buildGeometry(
  avatar: Avatar,
  shapes: readonly UnboundShape[],
  lod: AvatarLod,
  skin?: { readonly rig: Rig; readonly shapes: readonly AvatarShape[] },
): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  shapes.forEach((shape, at) => {
    const mesh = shapeMesh(shape, lod);
    const first = positions.length / 3;
    const colour = tintColour(avatar, shape.tint);
    const u = finishU(shape.finish);
    const bound = skin?.shapes[at];
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const [x = 0, y = 0] = mesh.positions.slice(index, index + 2);
      positions.push(...mesh.positions.slice(index, index + 3));
      colours.push(colour.r, colour.g, colour.b);
      uvs.push(u, 0.5);
      if (skin !== undefined && bound !== undefined) {
        const weights =
          bound.skirt === true
            ? skirtWeights(skin.rig, x, y)
            : [[bound.bone, 1] as const];
        for (let slot = 0; slot < 4; slot += 1) {
          const [bone, weight] = weights[slot] ?? ["hips", 0];
          skinIndices.push(boneNames.indexOf(bone));
          skinWeights.push(weight);
        }
      }
    }
    indices.push(...mesh.indices.map((index) => index + first));
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colours, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  if (skin !== undefined) {
    geometry.setAttribute(
      "skinIndex",
      new Uint16BufferAttribute(skinIndices, 4),
    );
    geometry.setAttribute(
      "skinWeight",
      new Float32BufferAttribute(skinWeights, 4),
    );
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A skirt's vertex: on the hips at the waist, more and more on the thighs
 * towards the hem, each side on its own thigh and the middle on both, so
 * it falls over the lap when the Avatar sits.
 */
function skirtWeights(
  rig: Rig,
  x: number,
  y: number,
): (readonly [BoneName, number])[] {
  const hip = rig.joints.leftThigh;
  const knee = rig.joints.leftShin[1];
  const down = Math.min(Math.max((hip[1] - y) / (hip[1] - knee), 0), 1);
  const across = Math.min(Math.max(x / hip[0], -1), 1);
  return [
    ["hips", 1 - down],
    ["leftThigh", down * (0.5 + across / 2)],
    ["rightThigh", down * (0.5 - across / 2)],
  ];
}

/** An Avatar's skinned geometry, at an LOD, on its rig. */
export function avatarGeometry(
  avatar: Avatar,
  lod: AvatarLod,
  rig: Rig = avatarRig(avatar),
  dress?: Dress,
): BufferGeometry {
  const plain = avatarShapes(avatar, rig);
  const shapes = dress === undefined ? plain : dress(plain, avatar, rig);
  return buildGeometry(avatar, shapes, lod, { rig, shapes });
}

/** The shared rig's bones for one Avatar, in `boneNames`' order, at rest. */
export function avatarSkeleton(rig: Rig): {
  readonly root: Bone;
  readonly skeleton: Skeleton;
} {
  const bones = new Map<BoneName, Bone>();
  for (const name of boneNames) {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(...rig.offsets[name]);
    const parent = boneParents[name];
    if (parent !== undefined) {
      bones.get(parent)?.add(bone);
    }
    bones.set(name, bone);
  }
  const ordered = boneNames.map((name) => {
    const bone = bones.get(name);
    if (bone === undefined) {
      throw new Error(`The rig has no bone ${name}.`);
    }
    return bone;
  });
  const [root] = ordered as [Bone, ...Bone[]];
  root.updateMatrixWorld(true);
  return { root, skeleton: new Skeleton(ordered) };
}

/** Samples between each pair of keys, so the curve between them shows. */
const samplesPerKey = 4;

/** Every bone's rotation in a pose, at rest where it names none. */
const fullRotations = (pose: Pose): Record<BoneName, Vec3> =>
  Object.fromEntries(
    boneNames.map((bone) => [bone, pose.rotations[bone] ?? [0, 0, 0]]),
  ) as Record<BoneName, Vec3>;

/** A Catmull-Rom curve's point between `b` and `c`, with `a` before and `d` after. */
const catmullRom = (a: number, b: number, c: number, d: number, t: number) =>
  b +
  0.5 *
    t *
    (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));

const curve = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, t: number): Vec3 => [
  catmullRom(a[0], b[0], c[0], d[0], t),
  catmullRom(a[1], b[1], c[1], d[1], t),
  catmullRom(a[2], b[2], c[2], d[2], t),
];

/**
 * The poses a clip passes through, at their times: its keys, and a smooth
 * curve through them (Catmull-Rom), so a motion flows through a key rather
 * than stopping at it. A loop's curve runs on round its end; a one-shot's
 * starts and ends at rest.
 */
export function sampledPoses(
  spec: AnimationSpec,
): { time: number; pose: Pose }[] {
  const keys = spec.keys.map(({ time, pose }) => ({
    time,
    rotations: fullRotations(pose),
    hips: pose.hips,
  }));
  const [first] = keys;
  if (first === undefined) {
    return [];
  }
  const count = keys.length;
  const at = (index: number) => {
    if (spec.loop) {
      return keys[((index % count) + count) % count] ?? first;
    }
    return keys[Math.min(Math.max(index, 0), count - 1)] ?? first;
  };
  const segments = spec.loop ? count : count - 1;
  const samples: { time: number; pose: Pose }[] = [];
  for (let index = 0; index < segments; index += 1) {
    const [a, b, c, d] = [
      at(index - 1),
      at(index),
      at(index + 1),
      at(index + 2),
    ];
    const end = spec.loop && index === count - 1 ? spec.duration : c.time;
    for (let step = 0; step < samplesPerKey; step += 1) {
      const t = step / samplesPerKey;
      const rotations = Object.fromEntries(
        boneNames.map((bone) => [
          bone,
          curve(
            a.rotations[bone],
            b.rotations[bone],
            c.rotations[bone],
            d.rotations[bone],
            t,
          ),
        ]),
      );
      samples.push({
        time: b.time + (end - b.time) * t,
        pose: { rotations, hips: curve(a.hips, b.hips, c.hips, d.hips, t) },
      });
    }
  }
  const last = spec.loop ? first : at(count - 1);
  samples.push({
    time: spec.loop ? spec.duration : last.time,
    pose: { rotations: last.rotations, hips: last.hips },
  });
  return samples;
}

/** An animation as a three.js clip for an Avatar on `rig`: every bone, and the hips' position. */
export function animationClip(spec: AnimationSpec, rig: Rig): AnimationClip {
  const samples = sampledPoses(spec);
  const times = samples.map(({ time }) => time);
  const quaternion = new Quaternion();
  const euler = new Euler();
  const tracks = [
    ...boneNames.map(
      (bone) =>
        new QuaternionKeyframeTrack(
          `${bone}.quaternion`,
          times,
          samples.flatMap(({ pose }) =>
            quaternion
              .setFromEuler(euler.set(...(pose.rotations[bone] ?? [0, 0, 0])))
              .toArray(),
          ),
        ),
    ),
    new VectorKeyframeTrack(
      "hips.position",
      times,
      samples.flatMap(({ pose }) => [
        rig.joints.hips[0] + pose.hips[0],
        rig.joints.hips[1] + pose.hips[1],
        rig.joints.hips[2] + pose.hips[2],
      ]),
    ),
  ];
  return new AnimationClip(spec.name, spec.duration, tracks);
}

/** Every animation for an Avatar on `rig`, by name. */
export function animationClips(rig: Rig): Record<AnimationName, AnimationClip> {
  const clips: Partial<Record<AnimationName, AnimationClip>> = {};
  for (const name of animationNames) {
    clips[name] = animationClip(animationSpec(name, rig), rig);
  }
  return clips as Record<AnimationName, AnimationClip>;
}

/**
 * A prop's shapes, in its right hand's space: the hand hangs down its -y,
 * the palm towards +x. A mug's handle is in the hand, the cup ahead of the
 * fingers' side; a ticket lies across both hands.
 */
function propShapes(prop: AvatarProp, rig: Rig): UnboundShape[] {
  const s = rig.scale;
  const base = { finish: "plastic", detail: "small" } as const;
  if (prop === "mug") {
    return [
      {
        ...base,
        name: "mug",
        kind: "frustum",
        tint: "ceramic",
        from: [0.05 * s, -0.06 * s, -0.045],
        to: [0.05 * s, -0.06 * s, 0.05],
        radii: [0.036, 0.04],
      },
      {
        ...base,
        name: "mug handle",
        kind: "torus",
        tint: "ceramic",
        detail: "tiny",
        at: [0.012 * s, -0.06 * s, 0],
        rotation: [0, Math.PI / 2, 0],
        radius: 0.022,
        tube: 0.006,
        arc: 0.5,
      },
    ];
  }
  // The games' and the weights' (FR-61), gripped in the fist, their
  // length along the fingers (-y) unless they lie across the palm.
  const grip = 0.035 * s;
  const fist = -0.07 * s;
  switch (prop) {
    case "ticket":
      return [
        {
          ...base,
          name: "ticket",
          kind: "box",
          tint: "paper",
          finish: "fabric",
          at: [0.12 * s, -0.12 * s, 0.03 * s],
          size: [0.21, 0.297, 0.004],
        },
      ];
    case "dart":
      return [
        {
          ...base,
          name: "dart barrel",
          kind: "frustum",
          tint: "metal-light",
          finish: "metal",
          detail: "tiny",
          from: [grip, fist + 0.03, 0],
          to: [grip, fist - 0.12, 0],
          radii: [0.007, 0.002],
        },
        {
          ...base,
          name: "dart flight",
          kind: "box",
          tint: "state-critical",
          at: [grip, fist + 0.05, 0],
          size: [0.002, 0.04, 0.03],
        },
      ];
    case "bat":
      return [
        {
          ...base,
          name: "bat handle",
          kind: "frustum",
          tint: "desk-top",
          detail: "tiny",
          from: [grip, fist + 0.04, 0],
          to: [grip, fist - 0.06, 0],
          radii: [0.014, 0.014],
        },
        {
          ...base,
          name: "bat blade",
          kind: "frustum",
          tint: "state-critical",
          from: [grip - 0.006, fist - 0.13, 0],
          to: [grip + 0.006, fist - 0.13, 0],
          radii: [0.075, 0.075],
        },
      ];
    case "dumbbell":
      return [
        {
          ...base,
          name: "dumbbell bar",
          kind: "frustum",
          tint: "metal-light",
          finish: "metal",
          detail: "tiny",
          from: [grip, fist, -0.12],
          to: [grip, fist, 0.12],
          radii: [0.014, 0.014],
        },
        ...[-1, 1].map((side): UnboundShape => ({
          ...base,
          name: `dumbbell weight ${side < 0 ? "behind" : "ahead"}`,
          kind: "frustum",
          tint: "ink",
          finish: "metal",
          from: [grip, fist, side * 0.07],
          to: [grip, fist, side * 0.13],
          radii: [0.05, 0.05],
        })),
      ];
    case "cue":
      // Held by its butt, so it reaches far ahead of the hand.
      return [
        {
          ...base,
          name: "pool cue",
          kind: "frustum",
          tint: "desk-top",
          finish: "plastic",
          detail: "tiny",
          from: [grip, fist + 0.12, 0],
          to: [grip, fist - 1.25, 0],
          radii: [0.014, 0.006],
        },
      ];
    case "putter":
      return [
        {
          ...base,
          name: "putter shaft",
          kind: "frustum",
          tint: "metal-light",
          finish: "metal",
          detail: "tiny",
          from: [grip, fist + 0.05, 0],
          to: [grip, fist - 0.62 * s, 0],
          radii: [0.011, 0.007],
        },
        {
          ...base,
          name: "putter head",
          kind: "box",
          tint: "metal-dark",
          finish: "metal",
          at: [grip, fist - 0.64 * s, 0.03],
          size: [0.03, 0.03, 0.11],
        },
      ];
  }
}

/** A prop's geometry, for its Avatar's right hand. */
export function propGeometry(
  avatar: Avatar,
  prop: AvatarProp,
  rig: Rig,
): BufferGeometry {
  return buildGeometry(avatar, propShapes(prop, rig), 1);
}

/**
 * Shapes tinted only by palette tokens and swatches, as one geometry for
 * the Avatars' material: the seasonal decorations.
 */
export function shapesGeometry(
  shapes: readonly UnboundShape[],
  lod: AvatarLod = 1,
): BufferGeometry {
  return buildGeometry(randomAvatar(seededRandom("decorations")), shapes, lod);
}

/** One of the things on an Avatar's desk: at the origin, facing +z, in its colours. */
export function deskItemGeometry(
  avatar: Avatar,
  item: DeskItemKind,
  lod: AvatarLod = 1,
): BufferGeometry {
  return buildGeometry(avatar, deskItemShapes(item), lod);
}

/** An Avatar's desk mascot: standing at the origin, facing +z, in its own colours. */
export function mascotGeometry(
  avatar: Avatar,
  lod: AvatarLod = 1,
): BufferGeometry {
  return buildGeometry(avatar, mascotShapes(avatar.deskMascot), lod);
}
