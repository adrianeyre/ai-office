import { describe, expect, it } from "vitest";

import {
  activeSeasonalActors,
  activeSeasonalEvents,
  defaultSeasonalEvents,
  formatActorLines,
  inSeason,
  parseActorLines,
  seasonalActorLines,
  seasonalActorIds,
  seasonalActors,
  seasonalEventExtraOn,
  seasonalEventKit,
  seasonalEventsSchema,
  seasonalExtraOn,
  type SeasonalEvents,
} from "./seasonal-events.ts";

const on = (month: number, day: number) => new Date(2026, month - 1, day, 12);

describe("seasonal events", () => {
  it("are on from their first day to the whole of their last, by the local date", () => {
    const events = (month: number, day: number) =>
      activeSeasonalEvents(defaultSeasonalEvents, on(month, day));
    expect(events(11, 30)).toEqual([]);
    expect(events(12, 1)).toEqual(["christmas"]);
    expect(events(12, 26)).toEqual(["christmas", "new-year"]);
    expect(events(12, 27)).toEqual(["new-year"]);
    expect(events(1, 7)).toEqual(["new-year"]);
    expect(events(1, 8)).toEqual([]);
    expect(events(10, 18)).toEqual([]);
    expect(events(10, 19)).toEqual(["halloween"]);
    expect(events(10, 31)).toEqual(["halloween"]);
    expect(events(3, 20)).toEqual(["easter"]);
    expect(events(3, 31)).toEqual([]);
    expect(
      activeSeasonalEvents(
        defaultSeasonalEvents,
        new Date(2026, 9, 31, 23, 59),
      ),
    ).toEqual(["halloween"]);
  });

  it("wrap the year when the last day comes before the first", () => {
    expect(inSeason("12-26", "01-07", on(12, 31))).toBe(true);
    expect(inSeason("12-26", "01-07", on(1, 1))).toBe(true);
    expect(inSeason("12-26", "01-07", on(6, 1))).toBe(false);
  });

  it("bring only the actors and extras turned on, of events turned on", () => {
    const settings: SeasonalEvents = structuredClone(defaultSeasonalEvents);
    expect(activeSeasonalActors(settings, on(10, 25))).toEqual([
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
    ]);
    settings.events.halloween.actors.ghost = false;
    settings.events.halloween.extras.costumes = false;
    expect(activeSeasonalActors(settings, on(10, 25))).not.toContain("ghost");
    expect(seasonalExtraOn(settings, "costumes", on(10, 25))).toBe(false);
    expect(seasonalExtraOn(settings, "party-hats", on(1, 1))).toBe(true);
    expect(seasonalExtraOn(settings, "party-hats", on(10, 25))).toBe(false);
    settings.events["new-year"].enabled = false;
    expect(seasonalExtraOn(settings, "party-hats", on(1, 1))).toBe(false);
    expect(activeSeasonalActors(settings, on(12, 10))).toEqual([
      "santa",
      "elf",
      "grinch",
    ]);
    expect(activeSeasonalActors(settings, on(12, 31))).toEqual([]);
    settings.events["new-year"].enabled = true;
    expect(activeSeasonalActors(settings, on(12, 31))).toEqual([
      "drunk-man",
      "drunk-woman",
    ]);
  });

  it("keep each event's decorations to itself", () => {
    const settings: SeasonalEvents = structuredClone(defaultSeasonalEvents);
    settings.events.christmas.extras.decorations = false;
    settings.events.christmas.extras.trees = false;
    // 26 December: Christmas and New Year both on.
    expect(
      seasonalEventExtraOn(settings, "christmas", "decorations", on(12, 26)),
    ).toBe(false);
    expect(
      seasonalEventExtraOn(settings, "new-year", "decorations", on(12, 26)),
    ).toBe(true);
    expect(
      seasonalEventExtraOn(settings, "christmas", "lights", on(12, 26)),
    ).toBe(true);
    expect(
      seasonalEventExtraOn(settings, "christmas", "trees", on(12, 26)),
    ).toBe(false);
    expect(
      seasonalEventExtraOn(settings, "christmas", "lights", on(12, 27)),
    ).toBe(false);
    expect(seasonalExtraOn(settings, "party-food", on(12, 25))).toBe(true);
  });

  it("turn Halloween's decorations, pumpkins and food and Easter's eggs on and off", () => {
    const settings: SeasonalEvents = structuredClone(defaultSeasonalEvents);
    expect(seasonalEventKit.halloween.extras).toEqual([
      "costumes",
      "decorations",
      "pumpkins",
      "halloween-food",
    ]);
    expect(seasonalEventKit.easter.extras).toEqual(["eggs"]);
    for (const extra of [
      "decorations",
      "pumpkins",
      "halloween-food",
    ] as const) {
      expect(
        seasonalEventExtraOn(settings, "halloween", extra, on(10, 25)),
      ).toBe(true);
      settings.events.halloween.extras[extra] = false;
      expect(
        seasonalEventExtraOn(settings, "halloween", extra, on(10, 25)),
      ).toBe(false);
    }
    expect(seasonalEventExtraOn(settings, "easter", "eggs", on(3, 25))).toBe(
      true,
    );
    expect(seasonalEventExtraOn(settings, "easter", "eggs", on(10, 25))).toBe(
      false,
    );
    settings.events.easter.extras.eggs = false;
    expect(seasonalEventExtraOn(settings, "easter", "eggs", on(3, 25))).toBe(
      false,
    );
    // Only the ghost floats; everyone else goes round on its feet.
    expect(
      seasonalActorIds.filter(
        (actor) => seasonalActors[actor].gait === "float",
      ),
    ).toEqual(["ghost"]);
  });

  it("give each actor its lines, written separated by commas", () => {
    expect(parseActorLines(" Boo!, , Wooo… ,Hello there ")).toEqual([
      "Boo!",
      "Wooo…",
      "Hello there",
    ]);
    expect(formatActorLines(["Boo!", "Wooo…"])).toBe("Boo!, Wooo…");
    const settings: SeasonalEvents = structuredClone(defaultSeasonalEvents);
    expect(seasonalActorLines(settings, "grinch")).toEqual(
      seasonalActors.grinch.says,
    );
    settings.events.christmas.says.grinch = ["Bah!", "Humbug!"];
    expect(seasonalActorLines(settings, "grinch")).toEqual(["Bah!", "Humbug!"]);
    // Not set: its own.
    delete settings.events.halloween.says.witch;
    expect(seasonalActorLines(settings, "witch")).toEqual(
      seasonalActors.witch.says,
    );
    // Saved settings from before lines could be written still read.
    const before: Partial<SeasonalEvents["events"]["easter"]> = structuredClone(
      defaultSeasonalEvents.events.easter,
    );
    delete before.says;
    expect(
      seasonalEventsSchema.safeParse({
        events: { ...defaultSeasonalEvents.events, easter: before },
      }).success,
    ).toBe(true);
    const silent = structuredClone(defaultSeasonalEvents);
    silent.events.easter.says["easter-bunny"] = [];
    expect(
      seasonalEventsSchema.safeParse(silent).error?.issues[0]?.message,
    ).toBe("Give each actor at least one thing to say.");
  });

  it("refuse a day that is not a day", () => {
    const with_ = (start: string) =>
      seasonalEventsSchema.safeParse({
        events: {
          ...defaultSeasonalEvents.events,
          easter: { ...defaultSeasonalEvents.events.easter, start },
        },
      }).success;
    expect(with_("02-29")).toBe(true);
    for (const bad of ["02-30", "13-01", "4-01", "04-31", "spring"]) {
      expect(with_(bad), bad).toBe(false);
    }
  });
});
