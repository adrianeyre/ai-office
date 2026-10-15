import { describe, expect, it } from "vitest";

import {
  accessoryKinds,
  avatarLook,
  avatarSchema,
  deskItemKinds,
  distinctFeatures,
  facialHairStyles,
  hairstyles,
  lookDistinct,
  outfitStyles,
  randomAvatar,
  sameAvatar,
  seededRandom,
  type Avatar,
  type Random,
} from "./avatar.ts";

/** A repeatable source of numbers in [0, 1). */
const seeded = (seed: number): Random => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

describe("a random Avatar", () => {
  it("is a valid Avatar", () => {
    const random = seeded(1);
    for (let index = 0; index < 200; index += 1) {
      const avatar = randomAvatar(random);
      expect(avatarSchema.parse(avatar)).toEqual(avatar);
      expect(avatar.outfit.secondaryColour).not.toBe(
        avatar.outfit.primaryColour,
      );
    }
  });

  it("is the same for the same random numbers", () => {
    expect(randomAvatar(seeded(7))).toEqual(randomAvatar(seeded(7)));
  });

  it("looks different from the others on its Floor", () => {
    const random = seeded(3);
    const floor = [randomAvatar(random)];
    for (let index = 0; index < 30; index += 1) {
      floor.push(randomAvatar(random, floor));
    }
    const looks = floor.map((avatar) => avatarLook(avatar).join(" "));
    expect(new Set(looks).size).toBe(floor.length);
  });

  it("differs from every other Avatar on its Floor in at least two features", () => {
    // A Floor of 12, a hundred times over, from a hundred seeds.
    for (let seed = 0; seed < 100; seed += 1) {
      const random = seededRandom(`floor-${String(seed)}`);
      const floor: Avatar[] = [];
      for (let index = 0; index < 12; index += 1) {
        floor.push(randomAvatar(random, floor));
      }
      for (const [index, avatar] of floor.entries()) {
        for (const other of floor.slice(index + 1)) {
          const theirs = avatarLook(other);
          const differences = avatarLook(avatar).filter(
            (feature, at) => feature !== theirs[at],
          ).length;
          expect(differences).toBeGreaterThanOrEqual(distinctFeatures);
          expect(lookDistinct(avatar, other)).toBe(true);
        }
      }
    }
  });

  it("is not distinct from an Avatar it differs from in one feature only", () => {
    const avatar = randomAvatar(seededRandom(1));
    expect(lookDistinct(avatar, avatar)).toBe(false);
    expect(
      lookDistinct(avatar, {
        ...avatar,
        hairColour: avatar.hairColour === "#1c1c1c" ? "#4a3021" : "#1c1c1c",
      }),
    ).toBe(false);
  });

  it("gives men alone facial hair, at random", () => {
    const random = seededRandom("beards");
    const avatars = Array.from({ length: 300 }, () => randomAvatar(random));
    expect(
      avatars.filter(
        ({ presentation, facialHair }) =>
          presentation !== "male" && facialHair !== "none",
      ),
    ).toEqual([]);
    expect(
      new Set(
        avatars
          .filter(({ presentation }) => presentation === "male")
          .map(({ facialHair }) => facialHair),
      ),
    ).toEqual(new Set(facialHairStyles));
  });

  it("uses every part of the kit, given enough Avatars", () => {
    const random = seededRandom("every part");
    const avatars = Array.from({ length: 500 }, () => randomAvatar(random));
    expect(new Set(avatars.map(({ hairstyle }) => hairstyle))).toEqual(
      new Set(hairstyles),
    );
    expect(new Set(avatars.map(({ outfit }) => outfit.style))).toEqual(
      new Set(outfitStyles),
    );
    expect(new Set(avatars.flatMap(({ accessories }) => accessories))).toEqual(
      new Set(accessoryKinds),
    );
  });

  it("gives up rather than loop when it can only repeat itself", () => {
    const always = () => 0;
    const only = randomAvatar(always);
    expect(() => randomAvatar(always, [only])).toThrow(
      "No Avatar unlike the other 1 in 1000 tries.",
    );
  });
});

describe("a seeded random source", () => {
  it("gives the same numbers for the same seed, in [0, 1)", () => {
    const one = seededRandom("web-shop");
    const again = seededRandom("web-shop");
    const numbers = Array.from({ length: 1000 }, () => one());
    expect(Array.from({ length: 1000 }, () => again())).toEqual(numbers);
    for (const number of numbers) {
      expect(number).toBeGreaterThanOrEqual(0);
      expect(number).toBeLessThan(1);
    }
    // Spread evenly enough to pick every option.
    const mean = numbers.reduce((sum, number) => sum + number, 0) / 1000;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("gives other numbers for another seed, a string or a number", () => {
    expect(seededRandom("web-shop")()).not.toBe(seededRandom("web-shop-2")());
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
    expect(seededRandom(1)()).toBe(seededRandom("1")());
  });

  it("gives a Floor the same Avatars from the same seed", () => {
    const floorFrom = (seed: string) => {
      const random = seededRandom(seed);
      const floor: Avatar[] = [];
      for (let index = 0; index < 12; index += 1) {
        floor.push(randomAvatar(random, floor));
      }
      return floor;
    };
    expect(floorFrom("web-shop")).toEqual(floorFrom("web-shop"));
    expect(floorFrom("web-shop")).not.toEqual(floorFrom("blog"));
  });
});

describe("the Avatar schema", () => {
  const avatar = randomAvatar(seededRandom("schema"));

  it("accepts every part of the kit", () => {
    for (const hairstyle of hairstyles) {
      expect(avatarSchema.safeParse({ ...avatar, hairstyle }).success).toBe(
        true,
      );
    }
    expect(
      avatarSchema.safeParse({ ...avatar, accessories: [...accessoryKinds] })
        .success,
    ).toBe(true);
  });

  it("offers thirty desk items, keeps up to five in order, and has none for an Avatar saved before them", () => {
    expect(deskItemKinds).toHaveLength(30);
    const items = ["laptop", "pen", "paper", "ruler", "coffee-mug"];
    expect(
      avatarSchema.parse({ ...avatar, deskItems: items }).deskItems,
    ).toEqual(items);
    const before: Partial<Avatar> = { ...avatar };
    delete before.deskItems;
    expect(avatarSchema.parse(before).deskItems).toEqual([]);
  });

  it("tells Avatars apart by their desk items", () => {
    expect(sameAvatar(avatar, { ...avatar, deskItems: ["pen"] })).toBe(false);
  });

  it.each([
    ["an unknown hairstyle", { hairstyle: "mohawk" }],
    ["an unknown presentation", { presentation: "robot" }],
    ["an unknown body shape", { bodyShape: "tall" }],
    ["an unknown face", { face: "triangle" }],
    ["unknown facial hair", { facialHair: "sideburns" }],
    ["unknown glasses", { glasses: "monocle" }],
    ["an unknown accessory", { accessories: ["cape"] }],
    ["an accessory worn twice", { accessories: ["watch", "watch"] }],
    ["an unknown desk mascot", { deskMascot: "unicorn" }],
    ["an unknown desk item", { deskItems: ["typewriter"] }],
    ["a desk item twice", { deskItems: ["pen", "pen"] }],
    [
      "more than five desk items",
      { deskItems: ["pen", "paper", "ruler", "laptop", "apple", "globe"] },
    ],
    ["an unknown part", { cape: "red" }],
    ["a hair colour that is not a colour", { hairColour: "blonde" }],
    ["a skin tone that is not a colour", { skinTone: "#fff" }],
    ["another version", { version: 2 }],
  ])("refuses %s", (_, change) => {
    expect(avatarSchema.safeParse({ ...avatar, ...change }).success).toBe(
      false,
    );
  });

  it("refuses an unknown outfit style, or an unknown part of an outfit", () => {
    expect(
      avatarSchema.safeParse({
        ...avatar,
        outfit: { ...avatar.outfit, style: "spacesuit" },
      }).success,
    ).toBe(false);
    expect(
      avatarSchema.safeParse({
        ...avatar,
        outfit: { ...avatar.outfit, tie: "#2b2b2b" },
      }).success,
    ).toBe(false);
  });

  it("refuses an Avatar missing a part", () => {
    const missing: Partial<Avatar> = { ...avatar };
    delete missing.glasses;
    expect(avatarSchema.safeParse(missing).success).toBe(false);
  });
});

describe("the same Avatar", () => {
  const avatar = randomAvatar(seeded(11));

  it("is the same whatever order its accessories are listed in, or its colours' case", () => {
    const worn: Avatar = {
      ...avatar,
      hairColour: "#2e6fd8",
      accessories: ["cap", "watch"],
    };
    expect(
      sameAvatar(worn, {
        ...worn,
        hairColour: "#2E6FD8",
        accessories: ["watch", "cap"],
      }),
    ).toBe(true);
    expect(sameAvatar(worn, structuredClone(worn))).toBe(true);
  });

  it("differs in any one part", () => {
    const changes: Partial<Avatar>[] = [
      { presentation: avatar.presentation === "male" ? "female" : "male" },
      { glasses: avatar.glasses === "round" ? "square" : "round" },
      { accessories: avatar.accessories.length === 0 ? ["scarf"] : [] },
      { outfit: { ...avatar.outfit, secondaryColour: "#000000" } },
      { deskMascot: avatar.deskMascot === "cat" ? "robot" : "cat" },
    ];
    for (const change of changes) {
      expect(sameAvatar(avatar, { ...avatar, ...change })).toBe(false);
    }
  });
});
