import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfficeSound, SoundControls } from "./office-sound.tsx";
import type { SoundPlayer } from "./sound-player.ts";
import {
  audible,
  resetSoundSettings,
  useSoundSettings,
  type SoundMix,
} from "./sound-settings.ts";

// The Office's sound in the page: the controls in the scene settings
// (muted by default, a volume each for the ambience and the music, and
// the Floor's ambience), and what `OfficeSound` asks its player to play.

beforeEach(() => {
  localStorage.clear();
  resetSoundSettings();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** A player that records each mix it is given. */
function recordingPlayer() {
  const mixes: SoundMix[] = [];
  const player: SoundPlayer = {
    apply: (mix) => {
      mixes.push(mix);
    },
    unlock: vi.fn(),
    dispose: vi.fn(),
  };
  return { player, mixes };
}

describe("the sound controls", () => {
  it("start muted", () => {
    render(<SoundControls floorId={undefined} />);
    const mute = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Mute office sound",
    });
    expect(mute.checked).toBe(true);
    expect(mute.closest("fieldset")).toBe(
      screen.getByRole("group", { name: "Sound" }),
    );
  });

  it("unmute, and set each volume", async () => {
    const user = userEvent.setup();
    render(<SoundControls floorId={undefined} />);
    await user.click(
      screen.getByRole("checkbox", { name: "Mute office sound" }),
    );
    expect(useSoundSettings.getState().muted).toBe(false);
    const ambience = screen.getByRole<HTMLInputElement>("slider", {
      name: "Ambience volume",
    });
    const music = screen.getByRole<HTMLInputElement>("slider", {
      name: "Music volume",
    });
    expect(ambience.value).toBe("60");
    expect(music.value).toBe("40");
    expect(ambience.getAttribute("aria-valuetext")).toBe("60%");
    fireEvent.change(ambience, { target: { value: "65" } });
    expect(useSoundSettings.getState().ambienceVolume).toBeCloseTo(0.65, 6);
    expect(ambience.getAttribute("aria-valuetext")).toBe("65%");
    fireEvent.change(music, { target: { value: "0" } });
    expect(useSoundSettings.getState().musicVolume).toBe(0);
  });

  it("choose the ambience of the Floor the lift is at, and none in the lobby", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SoundControls floorId="web-shop" />);
    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "This Floor’s ambience",
    });
    expect(select.value).toBe("open-plan");
    await user.selectOptions(select, "Café");
    expect(useSoundSettings.getState().floorAmbiences).toEqual({
      "web-shop": "cafe",
    });
    rerender(<SoundControls floorId="blog" />);
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: "This Floor’s ambience",
      }).value,
    ).toBe("open-plan");
    rerender(<SoundControls floorId={undefined} />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("the Office's sound", () => {
  it("plays nothing by default", () => {
    const { player, mixes } = recordingPlayer();
    render(
      <OfficeSound
        floorId="web-shop"
        working={1}
        createPlayer={() => player}
      />,
    );
    expect(mixes.length).toBeGreaterThan(0);
    expect(mixes.every((mix) => !audible(mix))).toBe(true);
  });

  it("plays the Floor's ambience once unmuted, follows the lift, and stops when muted again", () => {
    const { player, mixes } = recordingPlayer();
    const { rerender } = render(
      <OfficeSound
        floorId="web-shop"
        working={0.5}
        createPlayer={() => player}
      />,
    );
    act(() => {
      useSoundSettings.getState().setFloorAmbience("web-shop", "server-room");
      useSoundSettings.getState().setMuted(false);
    });
    expect(mixes.at(-1)).toMatchObject({ ambience: "server-room" });
    expect(audible(mixes.at(-1) ?? ({} as SoundMix))).toBe(true);
    rerender(
      <OfficeSound
        floorId={undefined}
        working={0}
        createPlayer={() => player}
      />,
    );
    expect(mixes.at(-1)).toMatchObject({ ambience: "lobby" });
    act(() => {
      useSoundSettings.getState().setMuted(true);
    });
    expect(audible(mixes.at(-1) ?? ({} as SoundMix))).toBe(false);
  });

  it("lets the browser play on the Owner's clicks and keys, and stops for good when it goes", () => {
    const { player } = recordingPlayer();
    const { unmount } = render(
      <OfficeSound
        floorId={undefined}
        working={0}
        createPlayer={() => player}
      />,
    );
    globalThis.dispatchEvent(new Event("pointerdown"));
    globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(player.unlock).toHaveBeenCalledTimes(2);
    unmount();
    expect(player.dispose).toHaveBeenCalledOnce();
  });
});
