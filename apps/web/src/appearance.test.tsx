import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppearanceCard } from "./appearance-card.tsx";
import {
  appearanceStorageKey,
  applyAppearance,
  useAppearance,
  useAppliedAppearance,
} from "./appearance.ts";

function Applied() {
  useAppliedAppearance();
  return <AppearanceCard />;
}

const root = document.documentElement;

beforeEach(() => {
  useAppearance.setState({ mode: "system", theme: "neutral" });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  root.classList.remove("dark");
  delete root.dataset["theme"];
});

describe("applyAppearance", () => {
  it.each([
    ["light", false, false],
    ["light", true, false],
    ["dark", false, true],
    ["system", false, false],
    ["system", true, true],
  ] as const)(
    "in %s mode, with the device dark: %s, is dark: %s",
    (mode, prefersDark, dark) => {
      applyAppearance({ mode, theme: "neutral" }, prefersDark);
      expect(root.classList.contains("dark")).toBe(dark);
    },
  );

  it("starts in Indigo, the logo's theme, as the device is set", () => {
    expect(useAppearance.getInitialState()).toMatchObject({
      mode: "system",
      theme: "indigo",
    });
  });

  it("sets the theme, and none for Neutral", () => {
    applyAppearance({ mode: "light", theme: "rose" }, false);
    expect(root.dataset["theme"]).toBe("rose");
    applyAppearance({ mode: "light", theme: "neutral" }, false);
    expect(root.dataset["theme"]).toBeUndefined();
  });
});

describe("the Appearance card", () => {
  it("offers three modes and six themes, as radios in labelled groups", () => {
    render(<AppearanceCard />);
    const mode = screen.getByRole("group", { name: "Mode" });
    const theme = screen.getByRole("group", { name: "Theme" });
    expect(mode.querySelectorAll("input[type=radio]")).toHaveLength(3);
    expect(theme.querySelectorAll("input[type=radio]")).toHaveLength(6);
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: /System/ }).checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: "Neutral" }).checked,
    ).toBe(true);
  });

  it("applies and keeps the choice", async () => {
    const user = userEvent.setup();
    render(<Applied />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.click(screen.getByRole("radio", { name: "Emerald" }));
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset["theme"]).toBe("emerald");
    expect(
      JSON.parse(localStorage.getItem(appearanceStorageKey) ?? "{}"),
    ).toMatchObject({ state: { mode: "dark", theme: "emerald" } });

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(root.classList.contains("dark")).toBe(false);
  });

  it("drops a stored theme it does not know, keeping the default", async () => {
    localStorage.setItem(
      appearanceStorageKey,
      JSON.stringify({ state: { mode: "dark", theme: "sepia" }, version: 0 }),
    );
    await useAppearance.persist.rehydrate();
    expect(useAppearance.getState()).toMatchObject({
      mode: "dark",
      theme: "neutral",
    });
  });
});
