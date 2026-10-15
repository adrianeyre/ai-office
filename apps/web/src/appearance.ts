import { useEffect } from "react";
import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// How this browser shows AI Office: light, dark or as the device is set,
// and one of six themes, Indigo (the logo's) unless another is chosen. Like the scene settings, they belong to the
// browser they were set in, and are kept in its local storage. The colours
// themselves are in styles.css; theme-contrast.test.ts checks every theme
// in both modes against WCAG 2.2 AA.

export const appearanceModes = ["light", "dark", "system"] as const;
export type AppearanceMode = (typeof appearanceModes)[number];

/** The themes, in the order the Admin page offers them; the first is the default. */
export const themes = [
  { id: "indigo", label: "Indigo", swatch: "#4338ca" },
  { id: "neutral", label: "Neutral", swatch: "#262637" },
  { id: "ocean", label: "Ocean", swatch: "#0369a1" },
  { id: "emerald", label: "Emerald", swatch: "#047857" },
  { id: "rose", label: "Rose", swatch: "#be123c" },
  { id: "amber", label: "Amber", swatch: "#b45309" },
] as const;
export type ThemeId = (typeof themes)[number]["id"];

const themeIds = themes.map(({ id }) => id) as [ThemeId, ...ThemeId[]];

/** Where the settings are kept; index.html reads it too, before first paint. */
export const appearanceStorageKey = "ai-office:appearance";

export interface Appearance {
  readonly mode: AppearanceMode;
  readonly theme: ThemeId;
}

const defaults: Appearance = { mode: "system", theme: "indigo" };

// Each stored value this version does not know (a theme since removed, say)
// is dropped on its own, and its default kept.
const storedAppearance = z.object({
  mode: z.enum(appearanceModes).optional().catch(undefined),
  theme: z.enum(themeIds).optional().catch(undefined),
});

export const useAppearance = create<
  Appearance & {
    readonly setMode: (mode: AppearanceMode) => void;
    readonly setTheme: (theme: ThemeId) => void;
  }
>()(
  persist(
    (set) => ({
      ...defaults,
      setMode: (mode) => {
        set({ mode });
      },
      setTheme: (theme) => {
        set({ theme });
      },
    }),
    {
      name: appearanceStorageKey,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ mode, theme }) => ({ mode, theme }),
      merge: (stored, current) => {
        const parsed = storedAppearance.safeParse(stored);
        return parsed.success
          ? {
              ...current,
              ...Object.fromEntries(
                Object.entries(parsed.data).filter(
                  ([, value]) => value !== undefined,
                ),
              ),
            }
          : current;
      },
    },
  ),
);

const darkQuery = "(prefers-color-scheme: dark)";

/** The browser bar's colour in each mode: the page's background. */
const themeColour = { light: "#f9fafd", dark: "#0a0c13" } as const;

/**
 * Shows `appearance` on `root`: the `dark` class (which the `dark:` variant
 * and the dark tokens follow), the theme, and the browser bar's colour.
 */
export function applyAppearance(
  { mode, theme }: Appearance,
  prefersDark: boolean,
  root: HTMLElement = document.documentElement,
): void {
  const dark = mode === "dark" || (mode === "system" && prefersDark);
  root.classList.toggle("dark", dark);
  if (theme === "neutral") {
    delete root.dataset["theme"];
  } else {
    root.dataset["theme"] = theme;
  }
  root.ownerDocument
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColour[dark ? "dark" : "light"]);
}

/** Keeps the page in step with the settings, and with the device in "system". */
export function useAppliedAppearance(): void {
  const mode = useAppearance((state) => state.mode);
  const theme = useAppearance((state) => state.theme);

  useEffect(() => {
    const query =
      typeof globalThis.matchMedia === "function"
        ? globalThis.matchMedia(darkQuery)
        : undefined;
    const apply = () => {
      applyAppearance({ mode, theme }, query?.matches ?? false);
    };
    apply();
    if (mode !== "system" || query === undefined) {
      return;
    }
    query.addEventListener("change", apply);
    return () => {
      query.removeEventListener("change", apply);
    };
  }, [mode, theme]);
}
