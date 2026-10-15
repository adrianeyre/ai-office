import { z } from "zod";

import { avatarSchema, type Avatar } from "./avatar.ts";

// The people of the Office who are not Agents: the Owner's profile, which
// the lobby's receptionist greets them by, and the lobby's cast, the
// receptionist behind the desk and the visitor who now and then waits on
// the sofa. Each of the cast has a name and an Avatar, set in Agent
// Settings like an Agent's.

/** British time: the Owner's time zone until they choose another. */
export const defaultTimeZone = "Europe/London";

/** Whether `timeZone` is an IANA time zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === "") {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const personName = (what: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, {
      error: `Use at most ${String(max)} characters for the ${what}.`,
    })
    .regex(/^[^<>\n\r]*$/, {
      error: `The ${what} cannot contain <, > or a line break.`,
    });

/**
 * The Owner's profile: who signs in with the Owner's password. Each name
 * may be empty; the greeting uses the nickname, else the forename.
 */
export const ownerProfileSchema = z.object({
  forename: personName("forename", 60),
  surname: personName("surname", 60),
  nickname: personName("nickname", 40),
  /** An IANA time zone, such as `Europe/London`. */
  timeZone: z.string().refine(isTimeZone, {
    error: "Choose a time zone from the list.",
  }),
});
export type OwnerProfile = z.infer<typeof ownerProfileSchema>;

/** Who uses an API key: a nickname and a time zone; its name is the key's. */
export const keyProfileSchema = ownerProfileSchema.pick({
  nickname: true,
  timeZone: true,
});
export type KeyProfile = z.infer<typeof keyProfileSchema>;

export const defaultKeyProfile: KeyProfile = {
  nickname: "",
  timeZone: defaultTimeZone,
};

export const defaultOwnerProfile: OwnerProfile = {
  forename: "",
  surname: "",
  nickname: "",
  timeZone: defaultTimeZone,
};

export type PartOfDay = "morning" | "afternoon" | "evening";

/** The hour (0 to 23) it is at `at` in `timeZone`. */
export function hourIn(at: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: isTimeZone(timeZone) ? timeZone : defaultTimeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).format(at);
  return Number.parseInt(hour, 10) % 24;
}

/** Morning until noon, afternoon until 6 pm, then evening. */
export function partOfDay(at: Date, timeZone: string): PartOfDay {
  const hour = hourIn(at, timeZone);
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

/** What the Owner is called: their nickname, else their forename. */
export const ownerCalled = (
  profile: Pick<OwnerProfile, "forename" | "nickname">,
): string | undefined =>
  profile.nickname.trim() || profile.forename.trim() || undefined;

/** The receptionist's greeting: `Hi, Ade. Good morning.` */
export function greeting(profile: OwnerProfile, at: Date): string {
  const called = ownerCalled(profile);
  const part = partOfDay(at, profile.timeZone);
  return `${called === undefined ? "Hi there" : `Hi, ${called}`}. Good ${part}.`;
}

/** The lobby's cast. */
export const lobbyRoles = ["receptionist", "visitor"] as const;
export type LobbyRole = (typeof lobbyRoles)[number];

export const lobbyCharacterSchema = z.object({
  name: personName("name", 60).pipe(
    z.string().min(1, { error: "Give them a name." }),
  ),
  avatar: avatarSchema,
});
export type LobbyCharacter = z.infer<typeof lobbyCharacterSchema>;

/** The body of `GET /api/office/lobby-cast`. */
export const lobbyCastSchema = z.object({
  receptionist: lobbyCharacterSchema,
  visitor: lobbyCharacterSchema,
});
export type LobbyCast = z.infer<typeof lobbyCastSchema>;

const receptionistAvatar: Avatar = {
  version: 1,
  presentation: "female",
  bodyShape: "average",
  face: "heart",
  hairstyle: "bun",
  hairColour: "#4a3021",
  skinTone: "#e0ac69",
  facialHair: "none",
  glasses: "cat-eye",
  accessories: ["earrings", "watch"],
  outfit: {
    style: "blazer",
    primaryColour: "#1f3a5f",
    secondaryColour: "#e8e4da",
  },
  deskMascot: "bonsai",
  deskItems: [],
};

const visitorAvatar: Avatar = {
  version: 1,
  presentation: "male",
  bodyShape: "broad",
  face: "square",
  hairstyle: "short",
  hairColour: "#1c1c1c",
  skinTone: "#8d5524",
  facialHair: "beard",
  glasses: "none",
  accessories: ["headphones"],
  outfit: {
    style: "sweater",
    primaryColour: "#2f6f4f",
    secondaryColour: "#2b2b2b",
  },
  deskMascot: "cat",
  deskItems: [],
};

/** The cast until the Owner changes them. */
export const defaultLobbyCast: LobbyCast = {
  receptionist: { name: "Rita", avatar: receptionistAvatar },
  visitor: { name: "Victor", avatar: visitorAvatar },
};

/** The id the API gives the Owner's first password, set at setup. */
export const firstPasswordId = "first";

/** An Owner password's name, nickname and time zone. */
export const ownerPasswordSettingsSchema = z.object({
  name: personName("name", 60).pipe(
    z.string().min(1, { error: "Give the password a name." }),
  ),
  nickname: personName("nickname", 40),
  timeZone: z.string().refine(isTimeZone, {
    error: "Choose a time zone from the list.",
  }),
});
export type OwnerPasswordSettings = z.infer<typeof ownerPasswordSettingsSchema>;

/** One of the Owner's passwords, as the API sends it: never the password. */
export const ownerPasswordInfoSchema = ownerPasswordSettingsSchema.extend({
  id: z.string(),
  /** Whether it is the first, set at setup, which cannot be removed. */
  first: z.boolean(),
  /** Null for the first. */
  createdAt: z.iso.datetime({ offset: true }).nullable(),
  /** When it last signed in; null if never, or not known (the first). */
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type OwnerPasswordInfo = z.infer<typeof ownerPasswordInfoSchema>;

/** The body of `GET /api/owner-passwords`. */
export const ownerPasswordListSchema = z.object({
  passwords: z.array(ownerPasswordInfoSchema),
});

/** An idle activity's name, as the web app's list of activities names it. */
const activityName = z.string().trim().min(1).max(80);

/** The body of `GET /api/office/activities`: those off, by Floor id. */
export const floorActivitiesSchema = z.object({
  disabled: z.record(z.string(), z.array(activityName)),
});
export type FloorActivities = z.infer<typeof floorActivitiesSchema>;

/** The body of `PUT /api/floors/:floorId/activities`. */
export const setFloorActivitiesRequestSchema = z.object({
  disabled: z
    .array(activityName)
    .max(200)
    .refine((names) => new Set(names).size === names.length, {
      error: "Name each activity once.",
    }),
});
