import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ambiences,
  ambienceIds,
  ambienceOf,
  audible,
  defaultFloorAmbience,
  defaultSoundSettings,
  floorAmbienceIds,
  musicLevel,
  resetSoundSettings,
  soundMix,
  useSoundSettings,
  type SoundSettings,
} from "./sound-settings.ts";

// Ambient office sound and music (PRD FR-64), as data: muted by default,
// with a volume each for the ambience and the music, and an ambience for
// each place, the lobby's own and each Floor's choice.

const storageKey = "ai-office:sound-settings";

/** The settings as a browser that stored `stored` has them on load. */
async function loaded(stored: unknown): Promise<SoundSettings> {
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state: stored, version: 0 }),
  );
  await useSoundSettings.persist.rehydrate();
  return useSoundSettings.getState();
}

const unmuted: SoundSettings = { ...defaultSoundSettings, muted: false };

beforeEach(() => {
  localStorage.clear();
  resetSoundSettings();
});

afterEach(() => {
  localStorage.clear();
});

describe("the sound settings", () => {
  it("are muted by default", () => {
    expect(defaultSoundSettings.muted).toBe(true);
    expect(useSoundSettings.getState().muted).toBe(true);
  });

  it("are muted in a browser that has stored nothing, or nothing it can read", async () => {
    expect((await loaded({})).muted).toBe(true);
    resetSoundSettings();
    expect((await loaded({ muted: "no", ambienceVolume: 7 })).muted).toBe(true);
    expect(useSoundSettings.getState().ambienceVolume).toBe(
      defaultSoundSettings.ambienceVolume,
    );
  });

  it("keep what the Owner set, in this browser", async () => {
    const settings = useSoundSettings.getState();
    settings.setMuted(false);
    settings.setAmbienceVolume(0.25);
    settings.setMusicVolume(0);
    settings.setFloorAmbience("web-shop", "cafe");
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as {
      state: unknown;
    };
    expect(stored.state).toEqual({
      muted: false,
      ambienceVolume: 0.25,
      musicVolume: 0,
      floorAmbiences: { "web-shop": "cafe" },
    });
    resetSoundSettings();
    expect(await loaded(stored.state)).toMatchObject({
      muted: false,
      ambienceVolume: 0.25,
      musicVolume: 0,
      floorAmbiences: { "web-shop": "cafe" },
    });
  });

  it("keep each volume between 0 and 1", () => {
    useSoundSettings.getState().setAmbienceVolume(3);
    useSoundSettings.getState().setMusicVolume(-1);
    expect(useSoundSettings.getState()).toMatchObject({
      ambienceVolume: 1,
      musicVolume: 0,
    });
  });

  it("drop a Floor's ambience this version does not know, keeping the others", async () => {
    const settings = await loaded({
      muted: false,
      floorAmbiences: { "web-shop": "jungle", blog: "quiet" },
    });
    expect(settings.floorAmbiences).toEqual({ blog: "quiet" });
  });
});

describe("a place's ambience", () => {
  it("is the lobby's in the lobby, and open plan on a Floor until the Owner picks another", () => {
    expect(ambienceOf(defaultSoundSettings, undefined)).toBe("lobby");
    expect(ambienceOf(defaultSoundSettings, "web-shop")).toBe("open-plan");
    expect(defaultFloorAmbience).toBe("open-plan");
    const chosen = { floorAmbiences: { "web-shop": "server-room" as const } };
    expect(ambienceOf(chosen, "web-shop")).toBe("server-room");
    expect(ambienceOf(chosen, "blog")).toBe("open-plan");
  });

  it("is one of the Floors' ambiences, each with its layers between 0 and 1", () => {
    expect(floorAmbienceIds).not.toContain("lobby");
    for (const id of ambienceIds) {
      const { roomTone, hum, murmur, clicks } = ambiences[id];
      for (const level of [roomTone, hum, murmur]) {
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(1);
      }
      expect(clicks).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("what plays", () => {
  it("is nothing at all by default, anywhere", () => {
    for (const floorId of [undefined, "web-shop"]) {
      const mix = soundMix(useSoundSettings.getState(), {
        floorId,
        working: 1,
      });
      expect(audible(mix)).toBe(false);
      expect(mix).toMatchObject({
        roomTone: 0,
        hum: 0,
        murmur: 0,
        clicks: 0,
        clicksPerSecond: 0,
        music: 0,
      });
    }
  });

  it("is nothing while muted, whatever the volumes", () => {
    const mix = soundMix(
      { ...defaultSoundSettings, ambienceVolume: 1, musicVolume: 1 },
      { floorId: "web-shop", working: 1 },
    );
    expect(audible(mix)).toBe(false);
  });

  it("is the place's ambience at the ambience volume, and the music at its own, once unmuted", () => {
    const settings = { ...unmuted, ambienceVolume: 0.5, musicVolume: 0.8 };
    const mix = soundMix(settings, { floorId: "web-shop", working: 0 });
    const { roomTone, hum, murmur } = ambiences["open-plan"];
    expect(mix).toMatchObject({
      ambience: "open-plan",
      roomTone: roomTone * 0.5,
      hum: hum * 0.5,
      murmur: murmur * 0.5,
      music: 0.8 * musicLevel,
    });
    expect(audible(mix)).toBe(true);
  });

  it("follows each Floor's own ambience", () => {
    const settings = {
      ...unmuted,
      floorAmbiences: { "web-shop": "cafe" as const, blog: "quiet" as const },
    };
    const shop = soundMix(settings, { floorId: "web-shop", working: 0 });
    const blog = soundMix(settings, { floorId: "blog", working: 0 });
    expect(shop.ambience).toBe("cafe");
    expect(blog.ambience).toBe("quiet");
    expect(shop.murmur).toBeGreaterThan(blog.murmur);
  });

  it("types as busily as the Floor's Agents work", () => {
    const at = (working: number) =>
      soundMix(unmuted, { floorId: "web-shop", working }).clicksPerSecond;
    expect(at(0)).toBe(0);
    expect(at(0.5)).toBeCloseTo(ambiences["open-plan"].clicks / 2, 6);
    expect(at(1)).toBe(ambiences["open-plan"].clicks);
    expect(soundMix(unmuted, { floorId: undefined, working: 1 }).clicks).toBe(
      0,
    );
  });

  it("is silent at volume 0", () => {
    const mix = soundMix(
      { ...unmuted, ambienceVolume: 0, musicVolume: 0 },
      { floorId: "web-shop", working: 1 },
    );
    expect(audible(mix)).toBe(false);
  });
});
