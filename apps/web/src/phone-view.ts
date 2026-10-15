import { useSyncExternalStore } from "react";

// Whether the screen is a phone's (PRD §7, Responsiveness): phones get a
// 2D view of the Office instead of the 3D one, while tablets and desktops
// get the 3D Office. A phone's screen is narrow (under 600 CSS pixels, as
// Material's compact window class is), or, turned on its side, short
// (under 480) with a finger for a pointer. A desktop window that narrow
// gets the 2D view too, as the 3D one would not fit it.

/** The media query a phone's screen matches. */
export const phoneQuery =
  "(max-width: 599px), (max-height: 479px) and (pointer: coarse)";

interface MediaQueries {
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
}

const media = (): MediaQueryList | undefined => {
  const { matchMedia } = globalThis as MediaQueries;
  return typeof matchMedia === "function" ? matchMedia(phoneQuery) : undefined;
};

const subscribe = (onChange: () => void) => {
  const list = media();
  list?.addEventListener("change", onChange);
  return () => {
    list?.removeEventListener("change", onChange);
  };
};

/** Whether the screen is a phone's now; false where it cannot be told. */
export const isPhone = (): boolean => media()?.matches ?? false;

/**
 * Whether the screen is a phone's, following it as it changes, such as a
 * window resized or a phone turned on its side.
 */
export function usePhoneView(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}
