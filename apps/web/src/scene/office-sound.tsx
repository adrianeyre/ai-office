import { useEffect, useId, useState } from "react";

import { selectClass } from "@/lib/utils.ts";

import { createSoundPlayer, type SoundPlayer } from "./sound-player.ts";
import {
  ambiences,
  defaultFloorAmbience,
  floorAmbienceIds,
  floorAmbienceOf,
  soundMix,
  useSoundSettings,
  type FloorAmbienceId,
} from "./sound-settings.ts";

// The Office's ambient sound and music (PRD FR-64): `OfficeSound` plays
// what the settings and the place call for, and `SoundControls` are the
// settings, in the scene settings panel. Muted by default; while muted,
// nothing is made or played at all.

/** Plays the ambience of where the lift is, and the music, as the settings say. */
export function OfficeSound({
  floorId,
  working,
  createPlayer = createSoundPlayer,
}: {
  /** The Floor the lift is at; the lobby without one. */
  floorId: string | undefined;
  /** The share of that Floor's Agents at work, 0 to 1. */
  working: number;
  /** For tests. */
  createPlayer?: () => SoundPlayer;
}) {
  const [player] = useState(createPlayer);
  useEffect(
    () => () => {
      player.dispose();
    },
    [player],
  );
  const settings = useSoundSettings();
  const mix = soundMix(settings, { floorId, working });
  const key = JSON.stringify(mix);
  useEffect(() => {
    player.apply(JSON.parse(key) as typeof mix);
  }, [player, key]);
  // Browsers play sound only after the Owner has interacted with the page.
  useEffect(() => {
    const unlock = () => {
      player.unlock();
    };
    globalThis.addEventListener("pointerdown", unlock);
    globalThis.addEventListener("keydown", unlock);
    return () => {
      globalThis.removeEventListener("pointerdown", unlock);
      globalThis.removeEventListener("keydown", unlock);
    };
  }, [player]);
  return null;
}

/** A volume, 0 to 100 on its slider. */
function VolumeSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        className="w-full accent-primary"
        value={Math.round(value * 100)}
        aria-valuetext={`${String(Math.round(value * 100))}%`}
        onChange={(event) => {
          onChange(Number(event.target.value) / 100);
        }}
      />
    </div>
  );
}

/** The sound settings: mute, the two volumes, and the Floor's ambience. */
export function SoundControls({
  floorId,
}: {
  /** The Floor the lift is at, whose ambience can be chosen; none in the lobby. */
  floorId: string | undefined;
}) {
  const id = useId();
  const settings = useSoundSettings();
  const ambience =
    floorId === undefined
      ? defaultFloorAmbience
      : floorAmbienceOf(settings, floorId);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">Sound</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={settings.muted}
          onChange={(event) => {
            settings.setMuted(event.target.checked);
          }}
        />
        Mute office sound
      </label>
      <VolumeSlider
        label="Ambience volume"
        value={settings.ambienceVolume}
        onChange={settings.setAmbienceVolume}
      />
      <VolumeSlider
        label="Music volume"
        value={settings.musicVolume}
        onChange={settings.setMusicVolume}
      />
      {floorId !== undefined && (
        <div className="space-y-1">
          <label htmlFor={`${id}-ambience`} className="block text-sm">
            This Floor&rsquo;s ambience
          </label>
          <select
            id={`${id}-ambience`}
            className={selectClass}
            value={ambience}
            onChange={(event) => {
              settings.setFloorAmbience(
                floorId,
                event.target.value as FloorAmbienceId,
              );
            }}
          >
            {floorAmbienceIds.map((each) => (
              <option key={each} value={each}>
                {ambiences[each].label}
              </option>
            ))}
          </select>
        </div>
      )}
    </fieldset>
  );
}
