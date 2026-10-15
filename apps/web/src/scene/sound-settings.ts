import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Ambient office sound and music in the Office (PRD FR-64), as data, so
// the player (office-sound-player.ts) only plays it. It is optional and
// muted by default: nothing plays until the Owner unmutes it in the
// scene settings. The ambience is the place's: the lobby's own, and each
// Floor's chosen one (open plan unless the Owner picks another), its
// keyboards as busy as the Floor's Agents at work. The music is a slow,
// soft progression of chords under it. Each has its own volume. Like the
// other scene settings, they belong to the browser they were set in.

/** The ambiences a place can have: the lobby's, and those a Floor can choose. */
export const ambienceIds = [
  "open-plan",
  "quiet",
  "cafe",
  "server-room",
  "lobby",
] as const;
export type AmbienceId = (typeof ambienceIds)[number];

/** The ambiences a Floor can have. */
export const floorAmbienceIds = [
  "open-plan",
  "quiet",
  "cafe",
  "server-room",
] as const satisfies readonly AmbienceId[];
export type FloorAmbienceId = (typeof floorAmbienceIds)[number];

/** A Floor's ambience until the Owner chooses another. */
export const defaultFloorAmbience: FloorAmbienceId = "open-plan";

/** An ambience's layers, each from 0 (none) to 1 (its loudest). */
export interface Ambience {
  readonly label: string;
  /** The room's own sound: soft, low, filtered noise. */
  readonly roomTone: number;
  /** The air conditioning's (or the racks') hum. */
  readonly hum: number;
  /** Far-off voices. */
  readonly murmur: number;
  /** Keyboard clicks a second, with every Agent at work. */
  readonly clicks: number;
}

export const ambiences: Readonly<Record<AmbienceId, Ambience>> = {
  "open-plan": {
    label: "Open plan",
    roomTone: 0.5,
    hum: 0.3,
    murmur: 0.2,
    clicks: 6,
  },
  quiet: { label: "Quiet", roomTone: 0.35, hum: 0.15, murmur: 0, clicks: 2 },
  cafe: { label: "Café", roomTone: 0.4, hum: 0.1, murmur: 0.5, clicks: 3 },
  "server-room": {
    label: "Server room",
    roomTone: 0.3,
    hum: 0.8,
    murmur: 0,
    clicks: 4,
  },
  lobby: { label: "Lobby", roomTone: 0.45, hum: 0.15, murmur: 0.3, clicks: 0 },
};

export interface SoundSettings {
  /** Nothing plays while muted, as it is until the Owner unmutes it. */
  readonly muted: boolean;
  /** The ambience's volume, 0 to 1. */
  readonly ambienceVolume: number;
  /** The music's volume, 0 to 1. */
  readonly musicVolume: number;
  /** Each Floor's ambience, by its id, where the Owner has chosen one. */
  readonly floorAmbiences: Readonly<Record<string, FloorAmbienceId>>;
}

export const defaultSoundSettings: SoundSettings = {
  muted: true,
  ambienceVolume: 0.6,
  musicVolume: 0.4,
  floorAmbiences: {},
};

/** A Floor's ambience: the Owner's choice, or the default. */
export const floorAmbienceOf = (
  settings: Pick<SoundSettings, "floorAmbiences">,
  floorId: string,
): FloorAmbienceId => settings.floorAmbiences[floorId] ?? defaultFloorAmbience;

/** A place's ambience: the lobby's, or its Floor's. */
export const ambienceOf = (
  settings: Pick<SoundSettings, "floorAmbiences">,
  floorId: string | undefined,
): AmbienceId =>
  floorId === undefined ? "lobby" : floorAmbienceOf(settings, floorId);

/** How loud music is at full volume, under the ambience. */
export const musicLevel = 0.5;

/** What plays: each layer's gain (0 to 1), the clicks a second, and the music's gain. */
export interface SoundMix {
  readonly ambience: AmbienceId;
  readonly roomTone: number;
  readonly hum: number;
  readonly murmur: number;
  /** The keyboards' clicks' gain, and how many a second. */
  readonly clicks: number;
  readonly clicksPerSecond: number;
  readonly music: number;
}

/** Whether a mix plays anything at all. */
export const audible = (mix: SoundMix): boolean =>
  mix.roomTone > 0 ||
  mix.hum > 0 ||
  mix.murmur > 0 ||
  mix.clicksPerSecond > 0 ||
  mix.music > 0;

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

/**
 * What plays where the Owner is: nothing at all while muted; otherwise
 * the place's ambience at the ambience volume, its keyboards as busy as
 * the share of its Agents at work (`working`, 0 to 1), and the music at
 * the music volume.
 */
export function soundMix(
  settings: SoundSettings,
  where: { readonly floorId: string | undefined; readonly working: number },
): SoundMix {
  const ambience = ambienceOf(settings, where.floorId);
  const layers = ambiences[ambience];
  const volume = settings.muted ? 0 : clamp(settings.ambienceVolume);
  return {
    ambience,
    roomTone: layers.roomTone * volume,
    hum: layers.hum * volume,
    murmur: layers.murmur * volume,
    clicks: layers.clicks > 0 ? volume : 0,
    clicksPerSecond: volume === 0 ? 0 : layers.clicks * clamp(where.working),
    music: settings.muted ? 0 : clamp(settings.musicVolume) * musicLevel,
  };
}

// Each stored value this version does not know is dropped on its own, and
// its default kept: muted, unless the Owner unmuted it.
const volume = z.number().min(0).max(1);
const storedSettings = z.object({
  muted: z.boolean().optional().catch(undefined),
  ambienceVolume: volume.optional().catch(undefined),
  musicVolume: volume.optional().catch(undefined),
  floorAmbiences: z
    .record(z.string(), z.enum(floorAmbienceIds).optional().catch(undefined))
    .optional()
    .catch(undefined),
});

export const useSoundSettings = create<
  SoundSettings & {
    readonly setMuted: (muted: boolean) => void;
    readonly setAmbienceVolume: (volume: number) => void;
    readonly setMusicVolume: (volume: number) => void;
    readonly setFloorAmbience: (
      floorId: string,
      ambience: FloorAmbienceId,
    ) => void;
  }
>()(
  persist(
    (set) => ({
      ...defaultSoundSettings,
      setMuted: (muted) => {
        set({ muted });
      },
      setAmbienceVolume: (ambienceVolume) => {
        set({ ambienceVolume: clamp(ambienceVolume) });
      },
      setMusicVolume: (musicVolume) => {
        set({ musicVolume: clamp(musicVolume) });
      },
      setFloorAmbience: (floorId, ambience) => {
        set((settings) => ({
          floorAmbiences: { ...settings.floorAmbiences, [floorId]: ambience },
        }));
      },
    }),
    {
      name: "ai-office:sound-settings",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ muted, ambienceVolume, musicVolume, floorAmbiences }) => ({
        muted,
        ambienceVolume,
        musicVolume,
        floorAmbiences,
      }),
      merge: (stored, current) => {
        const parsed = storedSettings.safeParse(stored);
        if (!parsed.success) {
          return current;
        }
        const { floorAmbiences, ...rest } = parsed.data;
        return {
          ...current,
          ...Object.fromEntries(
            Object.entries(rest).filter(([, value]) => value !== undefined),
          ),
          ...(floorAmbiences === undefined
            ? {}
            : {
                floorAmbiences: Object.fromEntries(
                  Object.entries(floorAmbiences).filter(
                    (entry): entry is [string, FloorAmbienceId] =>
                      entry[1] !== undefined,
                  ),
                ),
              }),
        };
      },
    },
  ),
);

/** Back to the defaults, without the stored settings; for tests. */
export function resetSoundSettings(): void {
  useSoundSettings.setState(defaultSoundSettings);
}
