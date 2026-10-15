import {
  accessoryKinds,
  bodyShapes,
  deskMascots,
  faces,
  facialHairStyles,
  glassesStyles,
  hairstyles,
  outfitStyles,
  presentations,
  randomAvatar,
  seededRandom,
  type Avatar,
} from "@ai-office/shared/avatar";
import {
  AnimationMixer,
  Group,
  LoopOnce,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from "three";
import { describe, expect, it } from "vitest";

import {
  animationNames,
  animationSpec,
  avatarProps,
  keyboardAt,
  rally,
  seatHeight,
} from "./avatar-animations.ts";
import {
  animationClip,
  animationClips,
  avatarGeometry,
  avatarLods,
  avatarSkeleton,
  avatarTriangleBudget,
  finishU,
  mascotGeometry,
  propGeometry,
  sampledPoses,
} from "./avatar-geometry.ts";
import { avatarFigure } from "./avatar-figure.ts";
import { avatarFinishes, avatarShapes, mascotShapes } from "./avatar-parts.ts";
import { avatarRig, boneNames, rigLimits, type Rig } from "./avatar-rig.ts";
import { desk } from "./desk-set.ts";
import { triangles } from "./piece-geometry.ts";
import { qualityLevels } from "./quality.ts";

// The character kit against the art direction (docs/reference/
// art-direction.md): one shared rig, a part for every option of FR-13
// tinted from the Avatar, within each quality setting's triangle budget,
// and the animation set, whose seated and squatting poses meet the chair,
// the floor and the keyboard on every body.

const base = randomAvatar(seededRandom("kit"));

/** Every body: each body shape in each presentation. */
const bodies: Avatar[] = bodyShapes.flatMap((bodyShape) =>
  presentations.map((presentation) => ({ ...base, bodyShape, presentation })),
);

/** The most a part of each kind can add: every accessory, glasses, a beard. */
const heaviest = (
  hairstyle: Avatar["hairstyle"],
  style: Avatar["outfit"]["style"],
): Avatar => ({
  ...base,
  hairstyle,
  facialHair: "beard",
  glasses: "round",
  accessories: [...accessoryKinds],
  outfit: { ...base.outfit, style },
});

/** Vertex colours, as a fingerprint of how an Avatar is tinted. */
const colours = (geometry: BufferGeometry) =>
  Array.from(geometry.getAttribute("color").array as Float32Array);

/** The geometry's positions, as a fingerprint of its shape. */
const positions = (geometry: BufferGeometry) =>
  Array.from(geometry.getAttribute("position").array as Float32Array);

/** An Avatar's bones posed by an animation at `time`. */
function posed(rig: Rig, name: (typeof animationNames)[number], time: number) {
  const { root } = avatarSkeleton(rig);
  const model = new Group();
  model.add(root);
  const mixer = new AnimationMixer(model);
  const action = mixer.clipAction(animationClip(animationSpec(name, rig), rig));
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(time);
  model.updateMatrixWorld(true);
  return (bone: (typeof boneNames)[number]) => {
    const found = model.getObjectByName(bone);
    if (found === undefined) {
      throw new Error(`No bone ${bone}.`);
    }
    return {
      at: found.getWorldPosition(new Vector3()),
      turn: found.getWorldQuaternion(new Quaternion()),
    };
  };
}

describe("the shared rig", () => {
  it("has the same bones for every Avatar, within the spec's 50", () => {
    expect(boneNames.length).toBeLessThanOrEqual(rigLimits.bones);
    for (const avatar of bodies) {
      const { skeleton } = avatarSkeleton(avatarRig(avatar));
      expect(skeleton.bones.map(({ name }) => name)).toEqual([...boneNames]);
    }
  });

  it("is 1.55 m to 1.85 m tall by body, 1.70 m on average, about six heads tall", () => {
    const heights = bodies.map((avatar) => avatarRig(avatar).height);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(1.55);
    expect(Math.max(...heights)).toBeLessThanOrEqual(1.85);
    const mean =
      heights.reduce((sum, height) => sum + height, 0) / heights.length;
    expect(mean).toBeCloseTo(1.7, 1);
    for (const avatar of bodies) {
      const rig = avatarRig(avatar);
      const heads = rig.height / (rig.head.radii[1] * 2);
      expect(heads).toBeGreaterThan(5.5);
      expect(heads).toBeLessThan(7);
      // The head's top is the Avatar's height.
      expect(rig.head.centre[1] + rig.head.radii[1]).toBeCloseTo(rig.height, 5);
    }
  });

  it("stands on the floor, facing +z with its left towards +x", () => {
    const rig = avatarRig(base);
    const shoes = avatarShapes(base, rig).filter(({ name }) =>
      name.endsWith("shoe"),
    );
    for (const shoe of shoes) {
      if (shoe.kind !== "ellipsoid") {
        throw new Error("A shoe is an ellipsoid.");
      }
      expect(shoe.at[1] - shoe.radii[1]).toBeCloseTo(0, 5);
      expect(shoe.at[2]).toBeGreaterThan(rig.joints.leftFoot[2]);
    }
    expect(rig.joints.leftUpperArm[0]).toBeGreaterThan(0);
    expect(rig.joints.rightUpperArm[0]).toBeLessThan(0);
  });
});

describe("the character kit", () => {
  it.each([
    [
      "presentation",
      presentations,
      (value: string) => ({ presentation: value }),
    ],
    ["body shape", bodyShapes, (value: string) => ({ bodyShape: value })],
    ["face", faces, (value: string) => ({ face: value })],
    ["hairstyle", hairstyles, (value: string) => ({ hairstyle: value })],
    [
      "facial hair",
      facialHairStyles,
      (value: string) => ({ facialHair: value }),
    ],
    ["glasses", glassesStyles, (value: string) => ({ glasses: value })],
    [
      "outfit style",
      outfitStyles,
      (value: string) => ({ outfit: { ...base.outfit, style: value } }),
    ],
    [
      "accessory",
      accessoryKinds,
      (value: string) => ({ accessories: [value] }),
    ],
  ] as const)("has a part of its own for every %s", (_, options, change) => {
    const looks = options.map((option) =>
      JSON.stringify(
        positions(avatarGeometry({ ...base, ...change(option) } as Avatar, 2)),
      ),
    );
    expect(new Set(looks).size).toBe(options.length);
  });

  it("has a desk mascot of its own for each of the Avatar Editor's", () => {
    const looks = deskMascots.map((mascot) =>
      JSON.stringify(
        positions(mascotGeometry({ ...base, deskMascot: mascot })),
      ),
    );
    expect(new Set(looks).size).toBe(deskMascots.length);
  });

  it("tints its parts with the Avatar's colours, and only the parts that wear them", () => {
    const avatar: Avatar = {
      ...base,
      hairstyle: "short",
      facialHair: "none",
      accessories: [],
      outfit: { ...base.outfit, style: "t-shirt" },
    };
    const before = colours(avatarGeometry(avatar, 2));
    const changes: [Partial<Avatar>, number][] = [
      [
        { hairColour: avatar.hairColour === "#b55239" ? "#2e6fd8" : "#b55239" },
        0,
      ],
      [{ skinTone: avatar.skinTone === "#3b2219" ? "#ffdbac" : "#3b2219" }, 0],
      [
        {
          outfit: {
            ...avatar.outfit,
            primaryColour:
              avatar.outfit.primaryColour === "#e8e4da" ? "#3f88c5" : "#e8e4da",
          },
        },
        0,
      ],
      [
        {
          outfit: {
            ...avatar.outfit,
            secondaryColour:
              avatar.outfit.secondaryColour === "#e8e4da"
                ? "#3f88c5"
                : "#e8e4da",
          },
        },
        0,
      ],
    ];
    const changed = changes.map(([change]) => {
      const after = colours(avatarGeometry({ ...avatar, ...change }, 2));
      // The shape is the same; some colours changed, and not all.
      expect(after.length).toBe(before.length);
      const differing = after.filter(
        (value, index) => value !== before[index],
      ).length;
      expect(differing).toBeGreaterThan(0);
      expect(differing).toBeLessThan(before.length / 2);
      return after.map((value, index) => value !== before[index]);
    });
    // Each colour tints its own parts: no two change the same vertices.
    for (const [index, one] of changed.entries()) {
      for (const other of changed.slice(index + 1)) {
        expect(one.some((differs, at) => differs && other[at] === true)).toBe(
          false,
        );
      }
    }
  });

  it("is within each quality setting's triangle budget, with LODs of about a half and a quarter", () => {
    let most = [0, 0, 0];
    for (const hairstyle of hairstyles) {
      for (const style of outfitStyles) {
        const avatar = heaviest(hairstyle, style);
        most = [0, 1, 2].map((lod) =>
          Math.max(most[lod] ?? 0, triangles(avatarGeometry(avatar, lod as 0))),
        );
      }
    }
    const [lod0 = 0, lod1 = 0, lod2 = 0] = most;
    for (const quality of qualityLevels) {
      expect(most[avatarLods[quality]]).toBeLessThanOrEqual(
        avatarTriangleBudget[quality],
      );
    }
    // Over 2,000 triangles, so it ships three LODs.
    expect(lod0).toBeGreaterThan(2000);
    expect(lod1 / lod0).toBeGreaterThan(0.4);
    expect(lod1 / lod0).toBeLessThan(0.6);
    expect(lod2 / lod0).toBeGreaterThan(0.18);
    expect(lod2 / lod0).toBeLessThan(0.34);
  });

  it("binds every vertex to at most four of the rig's bones, its weights adding to one", () => {
    for (const style of outfitStyles) {
      const geometry = avatarGeometry(heaviest("long", style), 2);
      const indices = geometry.getAttribute("skinIndex");
      const weights = geometry.getAttribute("skinWeight");
      expect(indices.itemSize).toBeLessThanOrEqual(
        rigLimits.influencesPerVertex,
      );
      for (let vertex = 0; vertex < weights.count; vertex += 1) {
        let sum = 0;
        for (let slot = 0; slot < weights.itemSize; slot += 1) {
          sum += weights.getComponent(vertex, slot);
          expect(indices.getComponent(vertex, slot)).toBeLessThan(
            boneNames.length,
          );
        }
        expect(sum).toBeCloseTo(1, 5);
      }
    }
  });

  it("shares a dress's skirt between the hips and the thighs, so it follows the legs", () => {
    const geometry = avatarGeometry(
      { ...base, outfit: { ...base.outfit, style: "dress" } },
      2,
    );
    const indices = geometry.getAttribute("skinIndex");
    const weights = geometry.getAttribute("skinWeight");
    const thighs = [
      boneNames.indexOf("leftThigh"),
      boneNames.indexOf("rightThigh"),
    ];
    let shared = 0;
    for (let vertex = 0; vertex < indices.count; vertex += 1) {
      if (
        thighs.includes(indices.getComponent(vertex, 1)) &&
        weights.getComponent(vertex, 1) > 0 &&
        weights.getComponent(vertex, 0) > 0
      ) {
        shared += 1;
      }
    }
    expect(shared).toBeGreaterThan(0);
  });

  it("gives every surface the finish the spec gives it: metal 1, the rest 0 and no shinier than 0.3", () => {
    for (const { metalness, roughness } of Object.values(avatarFinishes)) {
      expect([0, 1]).toContain(metalness);
      expect(roughness).toBeGreaterThanOrEqual(0.3);
    }
    const geometry = avatarGeometry(heaviest("short", "blazer"), 1);
    const us = new Set(
      Array.from(geometry.getAttribute("uv").array as Float32Array).filter(
        (_, index) => index % 2 === 0,
      ),
    );
    // Skin, hair, fabric, plastic and metal (the watch's face).
    expect(us).toEqual(
      new Set(
        (Object.keys(avatarFinishes) as (keyof typeof avatarFinishes)[])
          .map(finishU)
          .map(Math.fround),
      ),
    );
  });

  it("keeps its mascots small props, its props in hand", () => {
    for (const deskMascot of deskMascots) {
      // The spec's small prop: 300 triangles on Low, 500 on Medium.
      expect(
        triangles(mascotGeometry({ ...base, deskMascot }, 2)),
      ).toBeLessThanOrEqual(300);
      expect(
        triangles(mascotGeometry({ ...base, deskMascot }, 1)),
      ).toBeLessThanOrEqual(500);
      for (const shape of mascotShapes(deskMascot)) {
        const top =
          shape.kind === "capsule" || shape.kind === "frustum"
            ? Math.max(shape.from[1], shape.to[1])
            : shape.at[1];
        expect(top).toBeLessThan(0.13);
      }
    }
    const rig = avatarRig(base);
    for (const prop of avatarProps) {
      const geometry = propGeometry(base, prop, rig);
      geometry.computeBoundingSphere();
      // In the hand: all but the long ones, the cue and the putter, about
      // it, and those reaching on from it along the fingers.
      const reach = { cue: 0.75, putter: 0.45 } as Partial<
        Record<(typeof avatarProps)[number], number>
      >;
      expect(geometry.boundingSphere?.center.length(), prop).toBeLessThan(
        reach[prop] ?? 0.25,
      );
      expect(triangles(geometry), prop).toBeLessThanOrEqual(300);
    }
  });
});

describe("the animation set", () => {
  const rig = avatarRig(base);

  it("has the thirty animations, each for every bone of the rig", () => {
    expect([...animationNames]).toEqual([
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
      "run",
      "hop",
      "scare",
      "stagger",
      "sway",
      "float",
    ]);
    const clips = animationClips(rig);
    for (const name of animationNames) {
      const clip = clips[name];
      expect(clip.name).toBe(name);
      expect(clip.duration).toBeGreaterThan(0);
      expect(clip.validate()).toBe(true);
      expect(clip.tracks.map(({ name: track }) => track).sort()).toEqual(
        [
          ...boneNames.map((bone) => `${bone}.quaternion`),
          "hips.position",
        ].sort(),
      );
    }
  });

  it("ends each loop where it starts, and moves in each", () => {
    for (const name of animationNames) {
      const spec = animationSpec(name, rig);
      const samples = sampledPoses(spec);
      const first = samples[0];
      const last = samples.at(-1);
      expect(last?.time).toBe(spec.duration);
      if (spec.loop) {
        expect(last?.pose).toEqual(first?.pose);
      }
      const distinct = new Set(samples.map(({ pose }) => JSON.stringify(pose)));
      expect(distinct.size).toBeGreaterThan(2);
    }
  });

  it("holds a mug to drink, a ticket to carry and hand over, and the games' and weights' own, and nothing else", () => {
    const props = Object.fromEntries(
      animationNames.map((name) => [name, animationSpec(name, rig).prop]),
    );
    expect(
      Object.entries(props).filter(([, prop]) => prop !== undefined),
    ).toEqual([
      ["carry", "ticket"],
      ["hand-over", "ticket"],
      ["drink", "mug"],
      ["throw", "dart"],
      ["swing", "bat"],
      ["lift", "dumbbell"],
      ["pool", "cue"],
      ["putt", "putter"],
    ]);
  });

  it.each(
    bodies.map(
      (avatar) =>
        [`${avatar.bodyShape} ${avatar.presentation}`, avatar] as const,
    ),
  )(
    "sits a %s Avatar on the seat with its feet on the floor and its hands on the keys",
    (_, avatar) => {
      const body = avatarRig(avatar);
      for (const name of ["sit", "type", "sleep", "wait"] as const) {
        const spec = animationSpec(name, body);
        expect(spec.seated).toBe(true);
        for (const time of [0, spec.duration / 3, spec.duration / 2]) {
          const bone = posed(body, name, time);
          for (const side of ["left", "right"] as const) {
            // The thigh rests on the seat, neither in it nor above it.
            const hip = bone(`${side}Thigh`).at;
            expect(hip.y - body.limbRadii.thigh).toBeGreaterThan(
              seatHeight - 0.03,
            );
            expect(hip.y - body.limbRadii.thigh).toBeLessThan(
              seatHeight + 0.03,
            );
            // The ankle at its standing height: the sole on the floor.
            const ankle = bone(`${side}Foot`).at;
            expect(ankle.y).toBeCloseTo(body.joints.leftFoot[1], 1);
            expect(Math.abs(ankle.y - body.joints.leftFoot[1])).toBeLessThan(
              0.03,
            );
          }
        }
      }
      const typing = posed(body, "type", 0);
      for (const side of ["left", "right"] as const) {
        const wrist = typing(`${side}Hand`).at;
        // Just above the keyboard and behind its keys, over the desk.
        expect(wrist.y).toBeGreaterThan(keyboardAt.y);
        expect(wrist.y).toBeLessThan(keyboardAt.y + 0.07);
        expect(wrist.z).toBeGreaterThan(keyboardAt.z - 0.12);
        expect(wrist.z).toBeLessThan(keyboardAt.z);
        expect(Math.abs(wrist.x)).toBeLessThan(desk.width / 2);
      }
    },
  );

  it.each(
    bodies.map(
      (avatar) =>
        [`${avatar.bodyShape} ${avatar.presentation}`, avatar] as const,
    ),
  )(
    "waits on review as a %s Avatar: leaning back, its hands behind its head and its elbows out",
    (_, avatar) => {
      const body = avatarRig(avatar);
      const spec = animationSpec("wait", body);
      expect(spec.loop).toBe(true);
      const sitting = posed(body, "sit", 0);
      for (const time of [0, spec.duration / 3, spec.duration / 2]) {
        const bone = posed(body, "wait", time);
        const head = bone("head");
        // The head's centre, turned with it.
        const centre = new Vector3(...body.head.centre)
          .sub(new Vector3(...body.joints.head))
          .applyQuaternion(head.turn)
          .add(head.at);
        const [width, , depth] = body.head.radii;
        for (const side of ["left", "right"] as const) {
          const out = side === "left" ? 1 : -1;
          const wrist = bone(`${side}Hand`).at;
          // Behind the head, at its height, on its own side of it.
          expect(wrist.z).toBeLessThan(centre.z - depth * 0.8);
          expect(wrist.z).toBeGreaterThan(centre.z - depth - 0.12);
          expect(Math.abs(wrist.y - centre.y)).toBeLessThan(0.06);
          expect(out * wrist.x).toBeGreaterThan(0);
          expect(out * wrist.x).toBeLessThan(width);
          // Clear of the head: the forearm rests against it, not in it.
          const inHead = new Vector3(
            (wrist.x - centre.x) / width,
            (wrist.y - centre.y) / body.head.radii[1],
            (wrist.z - centre.z) / depth,
          ).length();
          expect(inHead).toBeGreaterThan(1);
          // The elbows out wide and up, past the shoulders.
          const elbow = bone(`${side}Forearm`).at;
          const shoulder = bone(`${side}UpperArm`).at;
          expect(out * elbow.x).toBeGreaterThan(out * shoulder.x + 0.05);
          expect(elbow.y).toBeGreaterThan(shoulder.y);
          // The upper arm and forearm keep their lengths: the solve is exact.
          expect(elbow.distanceTo(shoulder)).toBeCloseTo(
            body.upperArmLength,
            3,
          );
          expect(wrist.distanceTo(elbow)).toBeCloseTo(body.forearmLength, 3);
        }
        // Leaning back from where it sits.
        expect(bone("neck").at.z).toBeLessThan(sitting("neck").at.z - 0.03);
      }
    },
  );

  it.each(
    bodies.map(
      (avatar) =>
        [`${avatar.bodyShape} ${avatar.presentation}`, avatar] as const,
    ),
  )(
    "keeps a %s Avatar's feet where they stand while it works out and stands up",
    (_, avatar) => {
      const body = avatarRig(avatar);
      const spec = animationSpec("work-out", body);
      for (const time of [0, 0.5, 0.9, 1.5]) {
        const bone = posed(body, "work-out", time);
        const ankle = bone("leftFoot").at;
        expect(Math.abs(ankle.y - body.joints.leftFoot[1])).toBeLessThan(0.03);
        expect(Math.abs(ankle.z - body.joints.leftFoot[2])).toBeLessThan(0.03);
      }
      expect(spec.loop).toBe(true);
      const standUp = animationSpec("stand-up", body);
      expect(standUp.loop).toBe(false);
      const end = posed(body, "stand-up", standUp.duration);
      expect(end("hips").at.y).toBeCloseTo(body.joints.hips[1], 3);
    },
  );

  it.each(
    bodies.map(
      (avatar) =>
        [`${avatar.bodyShape} ${avatar.presentation}`, avatar] as const,
    ),
  )(
    "sits a %s Avatar back down as it stood up, and holds a ticket out to hand it over",
    (_, avatar) => {
      const body = avatarRig(avatar);
      const standUp = animationSpec("stand-up", body);
      const sitDown = animationSpec("sit-down", body);
      expect(sitDown.loop).toBe(false);
      expect(sitDown.seated).toBe(true);
      expect(sitDown.duration).toBe(standUp.duration);
      // Standing up, backwards: from standing to the seat.
      for (const time of [0, 0.3, 0.6, 0.9, standUp.duration]) {
        const down = posed(body, "sit-down", sitDown.duration - time);
        const up = posed(body, "stand-up", time);
        for (const bone of ["hips", "head", "leftFoot", "rightHand"] as const) {
          expect(down(bone).at.distanceTo(up(bone).at)).toBeLessThan(0.001);
        }
      }
      const seated = posed(body, "sit", 0);
      const sat = posed(body, "sit-down", sitDown.duration);
      expect(sat("hips").at.distanceTo(seated("hips").at)).toBeLessThan(0.001);

      const handOver = animationSpec("hand-over", body);
      expect(handOver.loop).toBe(false);
      expect(handOver.seated).toBe(false);
      const start = posed(body, "hand-over", 0);
      const given = posed(body, "hand-over", handOver.duration);
      for (const side of ["left", "right"] as const) {
        // Standing, its feet where they are.
        const ankle = given(`${side}Foot`).at;
        expect(Math.abs(ankle.y - body.joints.leftFoot[1])).toBeLessThan(0.03);
        // The ticket held out in front, then reached further forwards.
        const holding = start(`${side}Hand`).at;
        const reached = given(`${side}Hand`).at;
        expect(holding.z).toBeGreaterThan(0.2 * body.scale);
        expect(reached.z).toBeGreaterThan(holding.z + 0.07 * body.scale);
        expect(reached.y).toBeGreaterThan(body.joints.hips[1]);
        expect(reached.y).toBeLessThan(body.joints.head[1]);
      }
      // The ticket is in the hand as the carry left it.
      const carrying = posed(body, "carry", 0);
      expect(start("rightHand").at.z - carrying("rightHand").at.z).toBeCloseTo(
        0,
        1,
      );
    },
  );
});

describe("the games' and the weights' animations", () => {
  it.each(
    bodies.map(
      (avatar) =>
        [`${avatar.bodyShape} ${avatar.presentation}`, avatar] as const,
    ),
  )(
    "keep a %s Avatar's feet where they stand, standing, as it plays and lifts",
    (_, avatar) => {
      const body = avatarRig(avatar);
      for (const name of [
        "throw",
        "swing",
        "lift",
        "foosball",
        "pool",
        "shoot",
        "putt",
        "punch",
      ] as const) {
        const spec = animationSpec(name, body);
        expect(spec.seated, name).toBe(false);
        expect(spec.loop, name).toBe(true);
        for (const share of [0, 0.25, 0.5, 0.75]) {
          const bone = posed(body, name, share * spec.duration);
          for (const side of ["left", "right"] as const) {
            const ankle = bone(`${side}Foot`).at;
            const rest = body.joints[`${side}Foot`];
            expect(Math.abs(ankle.y - rest[1]), name).toBeLessThan(0.03);
            expect(Math.abs(ankle.z - rest[2]), name).toBeLessThan(0.03);
          }
        }
      }
    },
  );

  it("sit on the exercise bike's and the rowing machine's seats", () => {
    const body = avatarRig(base);
    for (const name of ["pedal", "row"] as const) {
      const spec = animationSpec(name, body);
      expect(spec.seated, name).toBe(true);
      for (const share of [0, 0.25, 0.5, 0.75]) {
        const hip = posed(body, name, share * spec.duration)("leftThigh").at;
        expect(
          Math.abs(hip.y - body.limbRadii.thigh - seatHeight),
        ).toBeLessThan(0.03);
      }
    }
  });

  it("throw a dart from by the eye, the hand going forwards as it lets go", () => {
    const body = avatarRig(base);
    const aiming = posed(body, "throw", 0);
    expect(aiming("rightHand").at.y).toBeGreaterThan(
      aiming("rightUpperArm").at.y,
    );
    const drawn = posed(body, "throw", 1)("rightHand").at;
    const thrown = posed(body, "throw", 1.2)("rightHand").at;
    expect(thrown.z).toBeGreaterThan(drawn.z + 0.1);
  });

  it("swing the bat out in front to meet the ball, in the rally's time", () => {
    const body = avatarRig(base);
    expect(animationSpec("swing", body).duration).toBe(rally.seconds);
    const back = posed(body, "swing", 0)("rightHand").at;
    const meeting = posed(body, "swing", rally.batMeetsBall)("rightHand").at;
    expect(meeting.z).toBeGreaterThan(back.z);
    expect(meeting.z).toBeGreaterThan(0.2 * body.scale);
  });
});

describe("an Avatar's figure", () => {
  it("is posed in its starting animation as it is made: an Agent sits at its desk from the first frame", () => {
    const rig = avatarRig(base);
    const figure = avatarFigure(base, 1, "sit");
    expect(figure.playing()).toBe("sit");
    figure.mesh.updateMatrixWorld(true);
    const at = figure.mesh
      .getObjectByName("hips")
      ?.getWorldPosition(new Vector3());
    const seated = posed(rig, "sit", 0)("hips").at;
    expect(at?.distanceTo(seated)).toBeLessThan(1e-3);
    // Lower than standing: in the chair, not stood in it.
    expect(at?.y).toBeLessThan(rig.joints.hips[1] - 0.2);
    const unposed = avatarFigure(base, 1);
    expect(unposed.playing()).toBeUndefined();
    figure.dispose();
    unposed.dispose();
  });

  it("walks again when played after it was disposed, as React's Strict Mode does", () => {
    const figure = avatarFigure(base, 1, "idle");
    figure.play("walk");
    // Strict Mode disposes a figure and keeps using it.
    figure.dispose();
    figure.play("walk");
    figure.mixer.update(0.25);
    expect(figure.playing()).toBe("walk");
    // Its walk is playing, not only remembered as played.
    expect(figure.mixer.stats.actions.inUse).toBe(1);
    figure.dispose();
  });
});
