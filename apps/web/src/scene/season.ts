import {
  activeSeasonalActors,
  activeSeasonalEvents,
  seasonalActorLines,
  seasonalEventExtraOn,
  seasonalExtraOn,
  type SeasonalActorId,
  type SeasonalEventId,
  type SeasonalEvents,
} from "@ai-office/shared";
import { create } from "zustand";

import { allDecorations, type DecorChoices } from "./seasonal-decor.ts";

// What the seasonal events bring to the Office now, by the viewer's own
// clock: the Office view sets it from the settings, each minute, and the
// scene's lobby, Floors and Agents dress up from it.

export interface Season {
  /** The events on, in the kit's order. */
  readonly events: readonly SeasonalEventId[];
  /** The actors who may step out of the lift. */
  readonly actors: readonly SeasonalActorId[];
  /** Whether the Agents wear Halloween costumes. */
  readonly costumes: boolean;
  /** Whether the Agents wear New Year party hats. */
  readonly partyHats: boolean;
  /** Whether there are nibbles on the meeting room table. */
  readonly nibbles: boolean;
  /** Whether there is Christmas party food on the meeting room table. */
  readonly partyFood: boolean;
  /** Whether there is Halloween food on the meeting room table. */
  readonly halloweenFood: boolean;
  /** Which of the events' decorations are up. */
  readonly decorations: DecorChoices;
  /** What each actor who may visit says, one line at each stop. */
  readonly lines: Readonly<Partial<Record<SeasonalActorId, readonly string[]>>>;
}

export const noSeason: Season = {
  events: [],
  actors: [],
  costumes: false,
  partyHats: false,
  nibbles: false,
  partyFood: false,
  halloweenFood: false,
  decorations: allDecorations,
  lines: {},
};

/** What the events bring at `at`. */
export function seasonAt(settings: SeasonalEvents, at: Date): Season {
  const actors = activeSeasonalActors(settings, at);
  const christmas = (extra: "trees" | "lights" | "decorations") =>
    seasonalEventExtraOn(settings, "christmas", extra, at);
  return {
    events: activeSeasonalEvents(settings, at),
    actors,
    costumes: seasonalExtraOn(settings, "costumes", at),
    partyHats: seasonalExtraOn(settings, "party-hats", at),
    nibbles: seasonalExtraOn(settings, "nibbles", at),
    partyFood: seasonalExtraOn(settings, "party-food", at),
    halloweenFood: seasonalExtraOn(settings, "halloween-food", at),
    decorations: {
      trees: christmas("trees"),
      lights: christmas("lights"),
      christmasDecorations: christmas("decorations"),
      halloweenDecorations: seasonalEventExtraOn(
        settings,
        "halloween",
        "decorations",
        at,
      ),
      pumpkins: seasonalEventExtraOn(settings, "halloween", "pumpkins", at),
      eggs: seasonalEventExtraOn(settings, "easter", "eggs", at),
      newYearDecorations: seasonalEventExtraOn(
        settings,
        "new-year",
        "decorations",
        at,
      ),
    },
    lines: Object.fromEntries(
      actors.map((actor) => [actor, seasonalActorLines(settings, actor)]),
    ),
  };
}

export const useSeason = create<Season>(() => noSeason);

/** Back to no season: for tests. */
export function resetSeason(): void {
  useSeason.setState(noSeason, true);
}
