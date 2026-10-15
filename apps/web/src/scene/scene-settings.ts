import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { defaultQuality, qualityLevels, type QualityLevel } from "./quality.ts";

// How this browser shows the 3D Office: its quality setting, reduced motion,
// the FPS overlay (PRD §7, Performance and Accessibility) and the display
// above each Agent's head (FR-62, FR-85). Like the
// browser notification settings, they belong to the browser they were set
// in, and are kept in its local storage.

export interface SceneSettings {
  readonly quality: QualityLevel;
  /** Camera moves cut straight to their view instead of flying there. */
  readonly reducedMotion: boolean;
  /** Show the frame rate over the scene. */
  readonly showFps: boolean;
  /**
   * Show the display above each Agent's head: its Context Usage bar and
   * its tokens today (FR-62, FR-85). One setting switches both off.
   */
  readonly showAboveHead: boolean;
}

// Each stored value this version does not know (a quality setting since
// removed, say) is dropped on its own, and its default kept.
const storedSettings = z.object({
  quality: z.enum(qualityLevels).optional().catch(undefined),
  reducedMotion: z.boolean().optional().catch(undefined),
  showFps: z.boolean().optional().catch(undefined),
  showAboveHead: z.boolean().optional().catch(undefined),
});

/**
 * Whether the browser asks for reduced motion, which is where the setting
 * starts until the Owner changes it.
 */
export function prefersReducedMotion(
  matchMedia: ((query: string) => { matches: boolean }) | undefined,
): boolean {
  return matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function initialSettings(): SceneSettings {
  return {
    quality: defaultQuality,
    reducedMotion: prefersReducedMotion(
      typeof globalThis.matchMedia === "function"
        ? (query) => globalThis.matchMedia(query)
        : undefined,
    ),
    showFps: false,
    showAboveHead: true,
  };
}

export const useSceneSettings = create<
  SceneSettings & {
    readonly setQuality: (quality: QualityLevel) => void;
    readonly setReducedMotion: (reducedMotion: boolean) => void;
    readonly setShowFps: (showFps: boolean) => void;
    readonly setShowAboveHead: (showAboveHead: boolean) => void;
  }
>()(
  persist(
    (set) => ({
      ...initialSettings(),
      setQuality: (quality) => {
        set({ quality });
      },
      setReducedMotion: (reducedMotion) => {
        set({ reducedMotion });
      },
      setShowFps: (showFps) => {
        set({ showFps });
      },
      setShowAboveHead: (showAboveHead) => {
        set({ showAboveHead });
      },
    }),
    {
      name: "ai-office:scene-settings",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ quality, reducedMotion, showFps, showAboveHead }) => ({
        quality,
        reducedMotion,
        showFps,
        showAboveHead,
      }),
      merge: (stored, current) => {
        const parsed = storedSettings.safeParse(stored);
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

/** Back to the defaults, without the stored settings; for tests. */
export function resetSceneSettings(): void {
  useSceneSettings.setState(initialSettings());
}
