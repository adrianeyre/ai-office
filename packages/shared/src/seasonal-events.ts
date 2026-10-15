import { z } from "zod";

// Seasonal events: for a few weeks a year the Office dresses up. Each has
// a date range (month and day, the same every year, by the viewer's
// clock), its decorations in the lobby and on every Floor, its extras
// (Christmas trees, lights and decorations, Halloween's decorations and
// pumpkins, Easter eggs all round the Floors, New Year's decorations, the
// Agents' costumes and party hats, food on the meeting room table) and
// its actors, who step out of the lift now and then, go round the Office,
// say one of their lines and leave the way they came. The Owner turns
// each event, extra and actor on or off, moves its dates and writes each
// actor's lines in General Settings.

export const seasonalEventIds = [
  "christmas",
  "halloween",
  "easter",
  "new-year",
] as const;
export type SeasonalEventId = (typeof seasonalEventIds)[number];

export const seasonalActorIds = [
  "santa",
  "elf",
  "grinch",
  "skeleton",
  "vampire",
  "ghost",
  "slasher",
  "night-stalker",
  "creepy-clown",
  "werewolf",
  "witch",
  "mummy",
  "zombie",
  "monster",
  "grim-reaper",
  "easter-bunny",
  "drunk-man",
  "drunk-woman",
] as const;
export type SeasonalActorId = (typeof seasonalActorIds)[number];

export const seasonalExtraIds = [
  "trees",
  "lights",
  "decorations",
  "party-food",
  "costumes",
  "party-hats",
  "nibbles",
  "pumpkins",
  "halloween-food",
  "eggs",
] as const;
export type SeasonalExtraId = (typeof seasonalExtraIds)[number];

/** What each event brings besides its decorations. */
export const seasonalEventKit: Readonly<
  Record<
    SeasonalEventId,
    {
      readonly name: string;
      readonly actors: readonly SeasonalActorId[];
      readonly extras: readonly SeasonalExtraId[];
    }
  >
> = {
  christmas: {
    name: "Christmas",
    actors: ["santa", "elf", "grinch"],
    extras: ["trees", "lights", "decorations", "party-food"],
  },
  halloween: {
    name: "Halloween",
    actors: [
      "skeleton",
      "vampire",
      "ghost",
      "slasher",
      "night-stalker",
      "creepy-clown",
      "werewolf",
      "witch",
      "mummy",
      "zombie",
      "monster",
      "grim-reaper",
    ],
    extras: ["costumes", "decorations", "pumpkins", "halloween-food"],
  },
  easter: { name: "Easter", actors: ["easter-bunny"], extras: ["eggs"] },
  "new-year": {
    name: "New Year",
    actors: ["drunk-man", "drunk-woman"],
    extras: ["decorations", "party-hats", "nibbles"],
  },
};

/** Each actor's name, how it goes round, and what it says unless told otherwise. */
export const seasonalActors: Readonly<
  Record<
    SeasonalActorId,
    {
      readonly name: string;
      /** How it goes round: a walk, a run, a hop, a stagger or, for the ghost, a float. */
      readonly gait: "walk" | "run" | "hop" | "stagger" | "float";
      /** Its lines: it says one over its head at each stop. */
      readonly says: readonly string[];
    }
  >
> = {
  santa: {
    name: "Santa",
    gait: "walk",
    says: ["Ho! Ho! Ho! Merry Christmas", "Have you been good this year?"],
  },
  elf: {
    name: "Elf",
    gait: "hop",
    says: [
      "Santa's on his way!",
      "Who wants a present?",
      "Jingle all the way!",
    ],
  },
  grinch: {
    name: "The Grinch",
    gait: "walk",
    says: [
      "Bah, humbug!",
      "I'm taking Christmas!",
      "All that noise, noise, noise!",
    ],
  },
  skeleton: {
    name: "Skeleton",
    gait: "run",
    says: ["Boo!", "I've got a bone to pick with you"],
  },
  vampire: {
    name: "Vampire",
    gait: "run",
    says: ["I vant to suck your tokens!", "Velcome to my office"],
  },
  ghost: { name: "Ghost", gait: "float", says: ["Wooooo!", "Boo!"] },
  slasher: {
    name: "Slasher",
    gait: "run",
    says: ["Heh heh heh…", "Behind you…"],
  },
  "night-stalker": {
    name: "Night Stalker",
    gait: "run",
    says: ["Sweet dreams…", "Don't fall asleep at your desk…"],
  },
  "creepy-clown": {
    name: "Creepy Clown",
    gait: "run",
    says: ["Want a balloon?", "We all float down here…"],
  },
  werewolf: {
    name: "Werewolf",
    gait: "run",
    says: ["Awoooo!", "Is it a full moon tonight?"],
  },
  witch: {
    name: "Witch",
    gait: "run",
    says: ["Hubble, bubble, toil and trouble!", "I'll get you, my pretty!"],
  },
  mummy: {
    name: "Mummy",
    gait: "run",
    says: ["Mmmmmmph!", "Who disturbed my tomb?"],
  },
  zombie: { name: "Zombie", gait: "run", says: ["Braaaains…", "Uuuurgh…"] },
  monster: {
    name: "Monster",
    gait: "run",
    says: ["It's alive!", "Rrrraaargh!"],
  },
  "grim-reaper": {
    name: "Grim Reaper",
    gait: "run",
    says: ["Your time is up…", "I've come for your build…"],
  },
  "easter-bunny": {
    name: "Easter Bunny",
    gait: "hop",
    says: ["Happy Easter!", "Anyone seen my eggs?"],
  },
  "drunk-man": {
    name: "Drunk Man",
    gait: "stagger",
    says: [
      "Happy New Year! Hic!",
      "I love you, mate!",
      "Should auld acquaintance… hic!",
    ],
  },
  "drunk-woman": {
    name: "Drunk Woman",
    gait: "stagger",
    says: [
      "Happy New Year, everyone! Hic!",
      "Who's got the bubbly?",
      "This is my song!",
    ],
  },
};

/** What each extra is. */
export const seasonalExtras: Readonly<Record<SeasonalExtraId, string>> = {
  trees: "Christmas trees",
  lights: "Christmas lights",
  decorations: "Decorations",
  "party-food": "Party food on the meeting room table",
  costumes: "Agents wear scary costumes",
  "party-hats": "Agents wear party hats",
  nibbles: "Nibbles on the meeting room table",
  pumpkins: "Pumpkins",
  "halloween-food": "Halloween food on the meeting room table",
  eggs: "Easter eggs all round the Floors",
};

/** A day of the year, `MM-DD`, the same every year. */
export const monthDaySchema = z
  .string()
  .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    error: "Give each day as a day from 1 to 31 and a month from 1 to 12.",
  })
  .refine(
    (day) => {
      const [month, date] = day.split("-").map(Number);
      // 2024 is a leap year, so 29 February is a day.
      const checked = new Date(2024, (month ?? 1) - 1, date);
      return checked.getMonth() === (month ?? 1) - 1;
    },
    { error: "That day is not in the month." },
  );
export type MonthDay = z.infer<typeof monthDaySchema>;

/** An actor's lines, as written: separated by commas. */
export const parseActorLines = (text: string): string[] =>
  text
    .split(",")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** An actor's lines to write: separated by commas. */
export const formatActorLines = (lines: readonly string[]): string =>
  lines.join(", ");

/** An actor's lines: at least one, each short enough for a speech bubble. */
export const actorLinesSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(120, { error: "Keep each line to 120 characters." }),
  )
  .min(1, { error: "Give each actor at least one thing to say." })
  .max(20, { error: "Give each actor at most 20 lines." });

export const seasonalEventSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Its first day; the last may be earlier in the year, for New Year. */
  start: monthDaySchema,
  /** Its last day, the whole of it. */
  end: monthDaySchema,
  /** Each of its actors, on or off. */
  actors: z.partialRecord(z.enum(seasonalActorIds), z.boolean()),
  /** Each of its extras, on or off. */
  extras: z.partialRecord(z.enum(seasonalExtraIds), z.boolean()),
  /** Each of its actors' lines; its own unless set. */
  says: z.partialRecord(z.enum(seasonalActorIds), actorLinesSchema).default({}),
});
export type SeasonalEventSettings = z.infer<typeof seasonalEventSettingsSchema>;

/**
 * The body of `GET` and `PUT /api/office/seasonal-events`: every event's
 * settings.
 */
export const seasonalEventsSchema = z.strictObject({
  events: z.strictObject({
    christmas: seasonalEventSettingsSchema,
    halloween: seasonalEventSettingsSchema,
    easter: seasonalEventSettingsSchema,
    "new-year": seasonalEventSettingsSchema,
  }),
});
export type SeasonalEvents = z.infer<typeof seasonalEventsSchema>;

const allOn = <Id extends string>(ids: readonly Id[]) =>
  Object.fromEntries(ids.map((id) => [id, true])) as Partial<
    Record<Id, boolean>
  >;

const defaults = (
  id: SeasonalEventId,
  start: MonthDay,
  end: MonthDay,
): SeasonalEventSettings => ({
  enabled: true,
  start,
  end,
  actors: allOn(seasonalEventKit[id].actors),
  extras: allOn(seasonalEventKit[id].extras),
  says: Object.fromEntries(
    seasonalEventKit[id].actors.map((actor) => [
      actor,
      [...seasonalActors[actor].says],
    ]),
  ),
});

/** Every event on, with its usual dates, all its actors and extras. */
export const defaultSeasonalEvents: SeasonalEvents = {
  events: {
    christmas: defaults("christmas", "12-01", "12-26"),
    halloween: defaults("halloween", "10-19", "10-31"),
    easter: defaults("easter", "03-20", "03-30"),
    "new-year": defaults("new-year", "12-26", "01-07"),
  },
};

const monthDayOf = (at: Date): MonthDay =>
  `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/** Whether `at`, by its local date, falls in `start` to `end`, wrapping the year. */
export function inSeason(start: MonthDay, end: MonthDay, at: Date): boolean {
  const day = monthDayOf(at);
  return start <= end ? day >= start && day <= end : day >= start || day <= end;
}

/** The events on at `at`, by the viewer's local date, in the kit's order. */
export function activeSeasonalEvents(
  settings: SeasonalEvents,
  at: Date,
): SeasonalEventId[] {
  return seasonalEventIds.filter((id) => {
    const event = settings.events[id];
    return event.enabled && inSeason(event.start, event.end, at);
  });
}

/** The actors who may visit at `at`: those turned on, of the events on. */
export function activeSeasonalActors(
  settings: SeasonalEvents,
  at: Date,
): SeasonalActorId[] {
  return activeSeasonalEvents(settings, at).flatMap((id) =>
    seasonalEventKit[id].actors.filter(
      (actor) => settings.events[id].actors[actor] !== false,
    ),
  );
}

/** Whether an extra is on at `at`, of an event that is on. */
export function seasonalExtraOn(
  settings: SeasonalEvents,
  extra: SeasonalExtraId,
  at: Date,
): boolean {
  return activeSeasonalEvents(settings, at).some(
    (id) =>
      seasonalEventKit[id].extras.includes(extra) &&
      settings.events[id].extras[extra] !== false,
  );
}

/** What an actor says, one line at each stop: its lines as set, or its own. */
export function seasonalActorLines(
  settings: SeasonalEvents,
  actor: SeasonalActorId,
): readonly string[] {
  const event = seasonalEventIds.find((id) =>
    seasonalEventKit[id].actors.includes(actor),
  );
  const set =
    event === undefined ? undefined : settings.events[event].says[actor];
  return set !== undefined && set.length > 0 ? set : seasonalActors[actor].says;
}

/** Whether an event's extra is on at `at`: the event on, the extra not off. */
export function seasonalEventExtraOn(
  settings: SeasonalEvents,
  event: SeasonalEventId,
  extra: SeasonalExtraId,
  at: Date,
): boolean {
  return (
    activeSeasonalEvents(settings, at).includes(event) &&
    seasonalEventKit[event].extras.includes(extra) &&
    settings.events[event].extras[extra] !== false
  );
}
