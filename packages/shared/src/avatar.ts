import { z } from "zod";

// An Agent's Avatar (PRD FR-13): how it looks in the Office, never how it
// works. It never reaches a model's prompt. New Agents get a random one,
// distinct from the others on their Floor; the Avatar Editor (#71) changes
// it. It runs in the browser too (the editor's "randomise"), so it uses no
// Node APIs. Each option is a part of the character kit the 3D Office
// draws (apps/web/src/scene/avatar-parts.ts), so the schema refuses any
// part the kit does not have.

export const presentations = ["male", "female", "androgynous"] as const;
export const bodyShapes = ["slim", "average", "broad", "curvy"] as const;
export const faces = ["oval", "round", "square", "heart", "long"] as const;
export const hairstyles = [
  "short",
  "crop",
  "bob",
  "long",
  "curly",
  "ponytail",
  "bun",
  "afro",
  "braids",
  "bald",
] as const;
export const facialHairStyles = [
  "none",
  "stubble",
  "moustache",
  "beard",
  "goatee",
] as const;
export const glassesStyles = ["none", "round", "square", "cat-eye"] as const;
export const accessoryKinds = [
  "headphones",
  "earrings",
  "watch",
  "scarf",
  "cap",
] as const;
export const outfitStyles = [
  "hoodie",
  "shirt",
  "blazer",
  "t-shirt",
  "sweater",
  "dress",
  "overalls",
] as const;
export const deskMascots = [
  "cactus",
  "rubber-duck",
  "robot",
  "cat",
  "bonsai",
  "dinosaur",
] as const;

/** What an Agent may keep on its desk, besides its mascot: at most `maxDeskItems`. */
export const deskItemKinds = [
  "laptop",
  "pen",
  "pencil",
  "paper",
  "ruler",
  "notebook",
  "coffee-mug",
  "stapler",
  "desk-lamp",
  "potted-plant",
  "sticky-notes",
  "calculator",
  "scissors",
  "tape-dispenser",
  "paper-clips",
  "pen-pot",
  "headphones",
  "phone",
  "tablet",
  "water-bottle",
  "book-stack",
  "desk-clock",
  "photo-frame",
  "tissue-box",
  "eraser",
  "highlighter",
  "envelope",
  "apple",
  "trophy",
  "globe",
] as const;
export type DeskItemKind = (typeof deskItemKinds)[number];

/** How many things a desk holds besides its mascot. */
export const maxDeskItems = 5;

export const hairColours = [
  "#1c1c1c",
  "#4a3021",
  "#8b5a2b",
  "#c68642",
  "#e6be8a",
  "#b55239",
  "#9e9e9e",
  "#f2f2f2",
  "#2e6fd8",
  "#d64f8f",
] as const;
export const skinTones = [
  "#3b2219",
  "#5c3a21",
  "#8d5524",
  "#a0662f",
  "#c68642",
  "#e0ac69",
  "#f1c27d",
  "#ffdbac",
] as const;
export const outfitColours = [
  "#1f3a5f",
  "#2f6f4f",
  "#8c2f39",
  "#d98e04",
  "#5b4b8a",
  "#2b2b2b",
  "#e8e4da",
  "#3f88c5",
  "#e07a5f",
  "#81b29a",
] as const;

const colour = z.string().regex(/^#[0-9a-f]{6}$/i);

const outfitSchema = z.strictObject({
  style: z.enum(outfitStyles),
  primaryColour: colour,
  secondaryColour: colour,
});

export const avatarSchema = z.strictObject({
  version: z.literal(1),
  /** The UI's pronouns follow it: he, she or they (FR-14). */
  presentation: z.enum(presentations),
  bodyShape: z.enum(bodyShapes),
  face: z.enum(faces),
  hairstyle: z.enum(hairstyles),
  hairColour: colour,
  skinTone: colour,
  facialHair: z.enum(facialHairStyles),
  glasses: z.enum(glassesStyles),
  /** Each worn at most once. */
  accessories: z
    .array(z.enum(accessoryKinds))
    .max(accessoryKinds.length)
    .refine((worn) => new Set(worn).size === worn.length, {
      message: "Each accessory is worn at most once.",
    }),
  outfit: outfitSchema,
  deskMascot: z.enum(deskMascots),
  /**
   * The things on its desk, in the order they are placed; each at most
   * once. None for an Avatar saved before desks had them.
   */
  deskItems: z
    .array(z.enum(deskItemKinds))
    .max(maxDeskItems, {
      error: `Choose at most ${String(maxDeskItems)} things for the desk.`,
    })
    .refine((kept) => new Set(kept).size === kept.length, {
      message: "Each thing is on the desk at most once.",
    })
    .default([]),
});
export type Avatar = z.infer<typeof avatarSchema>;

/**
 * Whether two Avatars are the same, whatever order their accessories are
 * listed in.
 */
export function sameAvatar(one: Avatar, other: Avatar): boolean {
  const canonical = (avatar: Avatar) =>
    JSON.stringify([
      avatar.version,
      avatar.presentation,
      avatar.bodyShape,
      avatar.face,
      avatar.hairstyle,
      avatar.hairColour.toLowerCase(),
      avatar.skinTone.toLowerCase(),
      avatar.facialHair,
      avatar.glasses,
      accessoryKinds.filter((kind) => avatar.accessories.includes(kind)),
      avatar.outfit.style,
      avatar.outfit.primaryColour.toLowerCase(),
      avatar.outfit.secondaryColour.toLowerCase(),
      avatar.deskMascot,
      avatar.deskItems,
    ]);
  return canonical(one) === canonical(other);
}

/** How the UI refers to an Agent (FR-14): he, she or they. */
export interface Pronouns {
  /** `he`, `she` or `they`. */
  readonly subject: string;
  /** `him`, `her` or `them`. */
  readonly object: string;
  /** `his`, `her` or `their`. */
  readonly possessive: string;
}

const pronounsByPresentation: Record<(typeof presentations)[number], Pronouns> =
  {
    male: { subject: "he", object: "him", possessive: "his" },
    female: { subject: "she", object: "her", possessive: "her" },
    androgynous: { subject: "they", object: "them", possessive: "their" },
  };

/** The pronouns the UI uses for an Agent, from its Avatar's presentation. */
export const pronounsOf = (avatar: Pick<Avatar, "presentation">): Pronouns =>
  pronounsByPresentation[avatar.presentation];

/** A source of numbers in [0, 1), like `Math.random`. */
export type Random = () => number;

const pick = <Value>(random: Random, values: readonly Value[]): Value => {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error("pick() needs a value to pick, and a random() in [0, 1).");
  }
  return value;
};

/**
 * A repeatable source of numbers in [0, 1) from a seed (mulberry32, seeded
 * by the string's FNV-1a hash): the same seed gives the same Avatars, in
 * the browser and on the server alike.
 */
export function seededRandom(seed: string | number): Random {
  let state = 0x81_1c_9d_c5;
  for (const character of String(seed)) {
    state = Math.imul(state ^ (character.codePointAt(0) ?? 0), 0x01_00_01_93);
  }
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** How many random Avatars `randomAvatar` tries before giving up. */
const maxAvatarAttempts = 1000;

/** What makes two Avatars look different at a glance, feature by feature. */
export const avatarLook = (avatar: Avatar): readonly string[] => [
  avatar.presentation,
  avatar.hairstyle,
  avatar.hairColour,
  avatar.skinTone,
  avatar.outfit.style,
  avatar.outfit.primaryColour,
];

/**
 * How many of those features two Avatars on one Floor differ in, at
 * least: one alone (two shades of brown hair) is easily missed from the
 * Office's high view.
 */
export const distinctFeatures = 2;

/** Whether two Avatars are told apart at a glance. */
export function lookDistinct(one: Avatar, other: Avatar): boolean {
  const theirs = avatarLook(other);
  const differences = avatarLook(one).filter(
    (feature, index) => feature !== theirs[index],
  ).length;
  return differences >= distinctFeatures;
}

/** One random Avatar. */
function anyAvatar(random: Random): Avatar {
  const primaryColour = pick(random, outfitColours);
  const presentation = pick(random, presentations);
  return {
    version: 1,
    presentation,
    bodyShape: pick(random, bodyShapes),
    face: pick(random, faces),
    hairstyle: pick(random, hairstyles),
    hairColour: pick(random, hairColours),
    skinTone: pick(random, skinTones),
    // Half the men have some; anyone may have it in the Avatar Editor.
    facialHair:
      presentation === "male" && random() < 0.5
        ? pick(random, facialHairStyles.slice(1))
        : "none",
    glasses: random() < 0.5 ? "none" : pick(random, glassesStyles),
    accessories: accessoryKinds.filter(() => random() < 0.2),
    outfit: {
      style: pick(random, outfitStyles),
      primaryColour,
      secondaryColour: pick(
        random,
        outfitColours.filter((colour) => colour !== primaryColour),
      ),
    },
    deskMascot: pick(random, deskMascots),
    deskItems: [],
  };
}

/**
 * A random Avatar that looks different from each of `others` (in at least
 * `distinctFeatures` of hair, skin, outfit and presentation), as each new
 * Agent's must from the others on its Floor. With `seededRandom` it is the
 * same Avatar for the same seed and Floor.
 */
export function randomAvatar(
  random: Random = Math.random,
  others: readonly Avatar[] = [],
): Avatar {
  // The odds of a clash are small, so this rarely tries more than twice.
  for (let attempt = 0; attempt < maxAvatarAttempts; attempt += 1) {
    const avatar = anyAvatar(random);
    if (others.every((other) => lookDistinct(avatar, other))) {
      return avatar;
    }
  }
  throw new Error(
    `No Avatar unlike the other ${String(others.length)} in ${String(maxAvatarAttempts)} tries.`,
  );
}
